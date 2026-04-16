import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";

import {
  NPM_REGISTRY,
  PUBLISHABLE_PACKAGES,
  appendSummary,
  getReleaseTag,
  parseArgs,
  readPackage,
  writeGithubOutput,
} from "./_shared.mjs";

const args = parseArgs();
const outputPath = args.output ?? ".release-manifest.json";
const allowNonReleaseHead = args["allow-non-release-head"] === true;
const packages = PUBLISHABLE_PACKAGES.map((approved) => {
  const manifest = readPackage(approved.dir);
  const publishedToNpm = isPublishedToNpm(manifest.name, manifest.version);

  return {
    dir: approved.dir,
    name: manifest.name,
    version: manifest.version,
    tag: getReleaseTag(manifest.name, manifest.version),
    publishedToNpm,
    needsPublish: !publishedToNpm,
    needsTagPush: !publishedToNpm,
    needsGithubRelease: !publishedToNpm,
  };
});

const actionablePackages = packages.filter((pkg) => pkg.needsPublish);
const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const headIsReleaseCommit = isReleaseCommit(headCommit);
const hasWork =
  actionablePackages.length > 0 && (headIsReleaseCommit || allowNonReleaseHead);
const releasePackages = hasWork ? actionablePackages : [];

const manifest = {
  mode: "stable",
  commit: headCommit,
  packages: releasePackages,
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const needsPublish = releasePackages.some((pkg) => pkg.needsPublish);
const needsTags = releasePackages.some((pkg) => pkg.needsTagPush);
const needsGithubReleases = releasePackages.some(
  (pkg) => pkg.needsGithubRelease,
);

writeGithubOutput("has_work", hasWork);
writeGithubOutput("needs_publish", needsPublish);
writeGithubOutput("needs_tags", needsTags);
writeGithubOutput("needs_github_releases", needsGithubReleases);
writeGithubOutput("package_count", releasePackages.length);
writeGithubOutput("manifest_path", outputPath);

if (!hasWork) {
  const message =
    actionablePackages.length === 0
      ? "No stable publish work is required on this main commit."
      : "Unpublished package versions exist, but HEAD is not a merged Changesets release commit, so stable publish is skipped.";
  console.log(message);
  appendSummary(`## Stable publish\n\n${message}`);
  process.exit(0);
}

const list = releasePackages
  .map((pkg) => `- ${pkg.name}@${pkg.version}`)
  .join("\n");

console.log(
  `Stable release work detected for ${releasePackages.length} package(s):\n${list}`,
);
appendSummary(`## Stable publish work detected\n\n${list}`);

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

function isReleaseCommit(commit) {
  const commitMessage = execFileSync(
    "git",
    ["log", "-1", "--pretty=%B", commit],
    {
      encoding: "utf8",
    },
  ).trim();
  return /\[ci\] release/i.test(commitMessage);
}
