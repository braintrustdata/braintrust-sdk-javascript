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

if (statusPath) {
  handleStatusManifest({
    headCommit,
    mode,
    outputPath,
    statusPath,
    title,
  });
} else {
  handleStableManifest({
    headCommit,
    mode,
    outputPath,
    title,
  });
}

function handleStatusManifest({
  headCommit,
  mode: currentMode,
  outputPath: currentOutputPath,
  statusPath: currentStatusPath,
  title: currentTitle,
}) {
  const status = JSON.parse(readFileSync(currentStatusPath, "utf8"));
  const releases = filterPublishableReleases(status);
  const packages = releases.map((release) => {
    const approved = getApprovedPackageByName(release.name);
    if (!approved) {
      throw new Error(
        `Unapproved publishable package in status file: ${release.name}`,
      );
    }

    const manifest = readPackage(approved.dir);
    return {
      dir: approved.dir,
      name: manifest.name,
      version: manifest.version,
      type: release.type,
      tag: getReleaseTag(manifest.name, manifest.version),
    };
  });

  writeManifestFile(currentOutputPath, {
    mode: currentMode,
    commit: headCommit,
    packages,
  });

  const markdownList = packagesToMarkdown(packages);
  const plainList = packagesToPlain(packages);

  writeGithubOutput("has_packages", packages.length > 0);
  writeGithubOutput("package_count", packages.length);
  writeGithubOutput("title", currentTitle);
  writeGithubOutput("markdown", markdownList);
  writeGithubOutput("plain", plainList);

  if (packages.length === 0) {
    const message = `No publishable packages would be released for ${currentMode}.`;
    console.log(message);
    process.exit(0);
  }

  console.log(
    `${packages.length} publishable package(s) would be released for ${currentMode}:\n${formatPackageList(packages)}`,
  );
}

function handleStableManifest({
  headCommit,
  mode: currentMode,
  outputPath: currentOutputPath,
  title: currentTitle,
}) {
  const packages = orderPackagesForPublish(getStableReleasePackages());
  const hasWork = packages.length > 0;
  const releaseManifest = {
    mode: currentMode,
    commit: headCommit,
    packages,
  };

  writeManifestFile(currentOutputPath, releaseManifest);

  const markdownList = packagesToMarkdown(packages);
  const plainList = packagesToPlain(packages);

  writeGithubOutput("has_work", hasWork);
  writeGithubOutput("needs_artifacts", hasWork);
  writeGithubOutput("package_count", packages.length);
  writeGithubOutput("manifest_json", JSON.stringify(releaseManifest));
  writeGithubOutput("title", currentTitle);
  writeGithubOutput("markdown", markdownList);
  writeGithubOutput("plain", plainList);

  if (!hasWork) {
    console.log("No stable release work was found at this ref.");
    process.exit(0);
  }

  console.log(
    `Stable release work detected for ${packages.length} package version(s):\n${formatPackageList(packages)}`,
  );
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
      buildStablePackageEntry(
        approvedPackage.dir,
        packageJson,
        alreadyPublished,
      ),
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

function buildStablePackageEntry(dir, packageJson, alreadyPublished) {
  const tag = getReleaseTag(packageJson.name, packageJson.version);
  const artifactBase = packageArtifactBase(
    packageJson.name,
    packageJson.version,
  );
  const channel = "latest";
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

function writeManifestFile(currentOutputPath, manifest) {
  writeFileSync(
    currentOutputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
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
