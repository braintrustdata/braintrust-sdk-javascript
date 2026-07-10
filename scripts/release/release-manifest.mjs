import { execFileSync } from "node:child_process";
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
  const packages = orderPackagesForPublish(
    releases.map((release) => {
      const approved = getApprovedPackageByName(release.name);
      if (!approved) {
        throw new Error(
          `Unapproved publishable package in status file: ${release.name}`,
        );
      }

      const packageJson = readPackage(approved.dir);
      return {
        ...buildPackageManifest(approved.dir, packageJson),
        type: release.type,
      };
    }),
  );

  writeManifestFile(currentOutputPath, {
    mode: currentMode,
    commit: headCommit,
    packages,
  });

  const markdownList = packagesToMarkdown(packages);
  const plainList = packagesToPlain(packages);
  const packageNamesJson = packagesToNamesJson(packages);

  writeGithubOutput("has_packages", packages.length > 0);
  writeGithubOutput("package_count", packages.length);
  writeGithubOutput("package_names_json", packageNamesJson);
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
  const packages = orderPackagesForPublish(getUnpublishedPackages());
  const hasWork = packages.length > 0;

  writeManifestFile(currentOutputPath, {
    mode: currentMode,
    commit: headCommit,
    packages,
  });

  const markdownList = packagesToMarkdown(packages);
  const plainList = packagesToPlain(packages);
  const packageNamesJson = packagesToNamesJson(packages);

  writeGithubOutput("has_work", hasWork);
  writeGithubOutput("needs_publish", hasWork);
  writeGithubOutput("package_count", packages.length);
  writeGithubOutput("package_names_json", packageNamesJson);
  writeGithubOutput("title", currentTitle);
  writeGithubOutput("markdown", markdownList);
  writeGithubOutput("plain", plainList);

  if (!hasWork) {
    console.log("No unpublished package versions were found at this ref.");
    process.exit(0);
  }

  console.log(
    `Stable release work detected for ${packages.length} unpublished package version(s):\n${formatPackageList(packages)}`,
  );
}

function getUnpublishedPackages() {
  return PUBLISHABLE_PACKAGES.map((approved) => {
    const manifest = readPackage(approved.dir);
    if (isPublishedToNpm(manifest.name, manifest.version)) {
      return null;
    }

    return {
      ...buildPackageManifest(approved.dir, manifest),
      published: false,
    };
  }).filter(Boolean);
}

function buildPackageManifest(dir, packageJson) {
  const tag = getReleaseTag(packageJson.name, packageJson.version);
  const artifactBase = packageArtifactBase(
    packageJson.name,
    packageJson.version,
  );

  return {
    dir,
    name: packageJson.name,
    version: packageJson.version,
    tag,
    tarball_asset: `${artifactBase}.tgz`,
    sbom_asset: `${artifactBase}.sbom.json`,
    release_title: tag,
    release_body: extractReleaseNotes(
      dir,
      packageJson.name,
      packageJson.version,
    ),
    channel: "latest",
    provenance: packageJson.publishConfig?.provenance ?? true,
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

function packagesToNamesJson(packages) {
  return JSON.stringify(packages.map((pkg) => pkg.name));
}

function getTitle(currentMode) {
  return currentMode
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
