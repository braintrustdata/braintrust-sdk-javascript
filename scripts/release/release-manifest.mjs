import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  PUBLISHABLE_PACKAGES,
  filterPublishableReleases,
  formatPackageList,
  getApprovedPackageByName,
  getReleaseTag,
  isPublishedToNpm,
  parseArgs,
  readPackage,
  writeGithubOutput,
} from "./_shared.mjs";

const args = parseArgs();
const mode = args.mode ?? "release";
const outputPath = args.output ?? ".release-manifest.json";
const statusPath = args["status-file"];
const sinceRef = args.since;

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
    sinceRef,
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
  sinceRef: currentSinceRef,
  title: currentTitle,
}) {
  const packages = (
    currentSinceRef
      ? getVersionedPackagesSince(currentSinceRef)
      : getUnpublishedPackages()
  ).map((pkg) => ({
    ...pkg,
    published: isPublishedToNpm(pkg.name, pkg.version),
  }));
  const hasWork = packages.length > 0;
  const packagesNeedingPublish = packages.filter((pkg) => !pkg.published);

  writeManifestFile(currentOutputPath, {
    mode: currentMode,
    commit: headCommit,
    since: currentSinceRef,
    packages,
  });

  const markdownList = packagesToMarkdown(packages);
  const plainList = packagesToPlain(packages);

  writeGithubOutput("has_work", hasWork);
  writeGithubOutput("needs_publish", packagesNeedingPublish.length > 0);
  writeGithubOutput("package_count", packages.length);
  writeGithubOutput("title", currentTitle);
  writeGithubOutput("markdown", markdownList);
  writeGithubOutput("plain", plainList);

  if (!hasWork) {
    const message = "No stable publish work is required for this ref.";
    console.log(message);
    process.exit(0);
  }

  console.log(
    `Stable release work detected for ${packages.length} package(s); ${packagesNeedingPublish.length} need npm publish:\n${formatPackageList(packages)}`,
  );
}

function getVersionedPackagesSince(sinceRef) {
  return PUBLISHABLE_PACKAGES.map((approved) => {
    const manifest = readPackage(approved.dir);
    const previousVersion = readPackageVersionAtRef(sinceRef, approved.dir);
    if (previousVersion === manifest.version) {
      return null;
    }

    return {
      dir: approved.dir,
      name: manifest.name,
      previousVersion,
      version: manifest.version,
      tag: getReleaseTag(manifest.name, manifest.version),
    };
  }).filter(Boolean);
}

function getUnpublishedPackages() {
  return PUBLISHABLE_PACKAGES.map((approved) => {
    const manifest = readPackage(approved.dir);
    if (isPublishedToNpm(manifest.name, manifest.version)) {
      return null;
    }

    return {
      dir: approved.dir,
      name: manifest.name,
      version: manifest.version,
      tag: getReleaseTag(manifest.name, manifest.version),
    };
  }).filter(Boolean);
}

function readPackageVersionAtRef(ref, relativeDir) {
  const content = execFileSync(
    "git",
    ["show", `${ref}:${relativeDir}/package.json`],
    {
      encoding: "utf8",
    },
  );
  return JSON.parse(content).version;
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
