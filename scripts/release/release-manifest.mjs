import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

import {
  NPM_REGISTRY,
  PUBLISHABLE_PACKAGES,
  filterPublishableReleases,
  formatPackageList,
  getApprovedPackageByName,
  getReleaseTag,
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
  const unpublishedPackages = PUBLISHABLE_PACKAGES.map((approved) => {
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

  const hasWork = unpublishedPackages.length > 0;
  const packages = unpublishedPackages;

  writeManifestFile(currentOutputPath, {
    mode: currentMode,
    commit: headCommit,
    packages,
  });

  const markdownList = packagesToMarkdown(packages);
  const plainList = packagesToPlain(packages);

  writeGithubOutput("has_work", hasWork);
  writeGithubOutput("needs_publish", packages.length > 0);
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
    `Stable release work detected for ${packages.length} package(s):\n${formatPackageList(packages)}`,
  );
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

function isPublishedToNpm(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", NPM_REGISTRY],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    return false;
  }

  return result.stdout.trim() === version;
}

function getTitle(currentMode) {
  return currentMode
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
