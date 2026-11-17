import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  PUBLISHABLE_PACKAGES,
  extractReleaseNotes,
  filterPublishableReleases,
  formatPackageList,
  getApprovedPackageByName,
  getReleaseTag,
  isPublishedToNpm,
  orderPackagesForPublish,
  packageArtifactBase,
  parseArgs,
  readPackage,
  writeGithubOutput,
} from "./_shared.mjs";

const args = parseArgs();
const mode = args.mode ?? "release";
const outputPath = args.output ?? ".release-manifest.json";
const statusPath = args["status-file"];

const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const title = getTitle(mode);

const packages = orderPackagesForPublish(
  statusPath ? getStatusReleasePackages() : getStableReleasePackages(),
);
const hasWork = packages.length > 0;
const releaseManifest = {
  mode,
  commit: headCommit,
  packages,
};

writeFileSync(
  outputPath,
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  "utf8",
);

writeGithubOutput("has_work", hasWork);
writeGithubOutput("needs_artifacts", hasWork);
writeGithubOutput("package_count", packages.length);
writeGithubOutput("manifest_json", JSON.stringify(releaseManifest));
writeGithubOutput("title", title);
writeGithubOutput("markdown", packagesToMarkdown(packages));
writeGithubOutput("plain", packagesToPlain(packages));

if (!hasWork) {
  console.log(`No ${mode} release work was found at this ref.`);
} else {
  console.log(
    `${mode} release work detected for ${packages.length} package version(s):\n${formatPackageList(packages)}`,
  );
}

function getStatusReleasePackages() {
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  return filterPublishableReleases(status).map((release) => {
    const approved = getApprovedPackageByName(release.name);
    const packageJson = readPackage(approved.dir);
    if (mode !== "prerelease" || !packageJson.version.includes("-rc.")) {
      throw new Error(
        `Expected an rc snapshot version for ${packageJson.name}, found ${packageJson.version}`,
      );
    }

    return {
      ...buildPackageEntry(
        approved.dir,
        packageJson,
        isPublishedToNpm(packageJson.name, packageJson.version),
      ),
      type: release.type,
    };
  });
}

function getStableReleasePackages() {
  const packages = [];

  for (const approvedPackage of PUBLISHABLE_PACKAGES) {
    const packageJson = readPackage(approvedPackage.dir);
    const alreadyPublished = isPublishedToNpm(
      packageJson.name,
      packageJson.version,
    );
    const tag = getReleaseTag(packageJson.name, packageJson.version);
    const tagCommit = getTagCommit(tag);

    if (tagCommit && tagCommit !== headCommit) {
      if (!alreadyPublished) {
        throw new Error(
          `${tag} points to ${tagCommit}, but ${packageJson.name}@${packageJson.version} is not published`,
        );
      }
      continue;
    }

    if (!tagCommit && alreadyPublished) {
      console.warn(
        `Skipping ${tag}: the package is already published but the release tag is missing`,
      );
      continue;
    }

    packages.push(
      buildPackageEntry(approvedPackage.dir, packageJson, alreadyPublished),
    );
  }

  return packages;
}

function getTagCommit(tag) {
  const tagRef = `refs/tags/${tag}`;
  const tagExists = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", tagRef],
    {
      encoding: "utf8",
    },
  );
  if (tagExists.error) {
    throw tagExists.error;
  }
  if (tagExists.status === 1) {
    return null;
  }
  if (tagExists.status !== 0) {
    throw new Error(`Failed to inspect release tag ${tag}`);
  }

  return execFileSync("git", ["rev-list", "-n", "1", tagRef], {
    encoding: "utf8",
  }).trim();
}

function buildPackageEntry(dir, packageJson, alreadyPublished) {
  const tag = getReleaseTag(packageJson.name, packageJson.version);
  const artifactBase = packageArtifactBase(
    packageJson.name,
    packageJson.version,
  );
  const channel = mode === "prerelease" ? "rc" : "latest";
  const npmVersionUrl = `https://www.npmjs.com/package/${encodeURIComponent(packageJson.name)}/v/${packageJson.version}`;

  return {
    dir,
    name: packageJson.name,
    version: packageJson.version,
    label: packageJson.name,
    tag,
    tarball_asset: `${artifactBase}.tgz`,
    sbom_asset: `${artifactBase}.sbom.json`,
    release_title: tag,
    release_body: extractReleaseNotes(
      dir,
      packageJson.name,
      packageJson.version,
    ),
    channel,
    provenance: packageJson.publishConfig?.provenance ?? true,
    registries: {
      npm: {
        name: packageJson.name,
        version: packageJson.version,
        version_url: npmVersionUrl,
        channel,
        already_published: alreadyPublished,
      },
    },
  };
}

function packagesToMarkdown(packages) {
  return packages.length === 0
    ? "- none"
    : packages.map((pkg) => `- ${pkg.name}@${pkg.version}`).join("\n");
}

function packagesToPlain(packages) {
  return packages.length === 0
    ? "none"
    : packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
}

function getTitle(currentMode) {
  return currentMode
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
