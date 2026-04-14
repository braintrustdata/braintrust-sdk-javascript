import { readFileSync } from "node:fs";

import {
  appendSummary,
  filterPublishableReleases,
  formatPackageList,
  parseArgs,
  writeGithubOutput,
} from "./_shared.mjs";

const args = parseArgs();
const statusPath = args["status-file"] ?? ".changeset-status.json";
const mode = args.mode ?? "release";
const status = JSON.parse(readFileSync(statusPath, "utf8"));

const releases = filterPublishableReleases(status);

writeGithubOutput("has_packages", releases.length > 0);
writeGithubOutput("package_count", releases.length);
writeGithubOutput(
  "package_names",
  releases.map((release) => release.name).join(","),
);

if (releases.length === 0) {
  const message = `No publishable packages would be released for ${mode}.`;
  console.log(message);
  appendSummary(`## ${titleCase(mode)}\n\n${message}`);
  process.exit(0);
}

const packageList = formatPackageList(
  releases.map((release) => ({
    name: release.name,
    version: release.newVersion ?? release.type,
  })),
);

console.log(
  `${releases.length} publishable package(s) would be released for ${mode}:\n${packageList}`,
);
appendSummary(
  `## ${titleCase(mode)}\n\n${releases.length} publishable package(s) have pending release intent:\n${packageList}`,
);

function titleCase(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
