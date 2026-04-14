import { readFileSync } from "node:fs";

import { appendSummary, parseArgs, writeGithubOutput } from "./_shared.mjs";

const args = parseArgs();
const mode = args.mode ?? "release";
const manifestPath = args.manifest ?? ".release-manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packages = manifest.packages ?? [];

const title = getTitle(mode);
const markdownList =
  packages.length === 0
    ? "- none"
    : packages.map((pkg) => `- ${pkg.name}@${pkg.version}`).join("\n");
const plainList =
  packages.length === 0
    ? "none"
    : packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");

appendSummary(`## ${title}\n\n${markdownList}`);
writeGithubOutput("count", packages.length);
writeGithubOutput("markdown", markdownList);
writeGithubOutput("plain", plainList);
writeGithubOutput("title", title);

console.log(`${title}: ${plainList}`);

function getTitle(currentMode) {
  switch (currentMode) {
    case "stable":
      return "Stable release";
    case "prerelease":
      return "Prerelease snapshot";
    case "canary":
      return "Canary snapshot";
    case "dry-run-stable":
      return "Stable dry run";
    case "dry-run-prerelease":
      return "Prerelease dry run";
    case "dry-run-canary":
      return "Canary dry run";
    default:
      return "Release";
  }
}
