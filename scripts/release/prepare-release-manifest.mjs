import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  appendSummary,
  filterPublishableReleases,
  getApprovedPackageByName,
  getReleaseTag,
  parseArgs,
  readPackage,
  writeGithubOutput,
} from "./_shared.mjs";

const args = parseArgs();
const statusPath = args["status-file"] ?? ".changeset-status.json";
const outputPath = args.output ?? ".release-manifest.json";
const mode = args.mode ?? "release";

const status = JSON.parse(readFileSync(statusPath, "utf8"));
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

const manifest = {
  mode,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  packages,
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

writeGithubOutput("has_packages", packages.length > 0);
writeGithubOutput("package_count", packages.length);
writeGithubOutput("manifest_path", outputPath);

if (packages.length === 0) {
  appendSummary(`## ${mode}\n\nNo publishable packages are queued.`);
  console.log("No publishable packages found in status file.");
  process.exit(0);
}

const packageLines = packages
  .map((pkg) => `- ${pkg.name}@${pkg.version} (${pkg.type})`)
  .join("\n");
appendSummary(`## ${mode}\n\nPrepared release manifest:\n${packageLines}`);
console.log(`Prepared release manifest at ${outputPath}:\n${packageLines}`);
