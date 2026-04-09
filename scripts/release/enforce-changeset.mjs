import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { PUBLISHABLE_PACKAGES } from "./_shared.mjs";

if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
  console.log("Changeset enforcement only runs on pull_request events.");
  process.exit(0);
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  throw new Error("GITHUB_EVENT_PATH is required");
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request;
const labels = new Set((pullRequest.labels ?? []).map((label) => label.name));
const title = pullRequest.title ?? "";
const body = pullRequest.body ?? "";

if (
  title.trim() === "[ci] release" ||
  labels.has("skip-changeset") ||
  /#skip-changeset/i.test(title) ||
  /#skip-changeset/i.test(body)
) {
  console.log("Changeset requirement bypassed for this pull request.");
  process.exit(0);
}

const baseRef = process.env.GITHUB_BASE_REF;
if (!baseRef) {
  throw new Error("GITHUB_BASE_REF is required for pull_request checks");
}

const changedFiles = execFileSync(
  "git",
  ["diff", "--name-only", `origin/${baseRef}...HEAD`],
  { encoding: "utf8" },
)
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);

const publishableDirs = PUBLISHABLE_PACKAGES.map((pkg) => `${pkg.dir}/`);
const touchedPublishableFiles = changedFiles.filter((file) =>
  publishableDirs.some((dir) => file.startsWith(dir)),
);

if (touchedPublishableFiles.length === 0) {
  console.log("No publishable package paths changed; no changeset required.");
  process.exit(0);
}

const hasChangeset = changedFiles.some(
  (file) => file.startsWith(".changeset/") && file.endsWith(".md"),
);

if (hasChangeset) {
  console.log(
    "Found at least one changeset file for publishable package changes.",
  );
  process.exit(0);
}

console.error("Missing changeset for publishable package changes.");
console.error("Touched publishable files:");
for (const file of touchedPublishableFiles) {
  console.error(`- ${file}`);
}
console.error(
  "Add a .changeset/*.md file with `pnpm changeset`, or apply the skip-changeset label or add #skip-changeset to the PR title/body when no release is intended.",
);
process.exit(1);
