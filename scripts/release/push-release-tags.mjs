import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { appendSummary, parseArgs } from "./_shared.mjs";

const args = parseArgs();
const manifestPath = args.manifest ?? ".release-manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const targetCommit = manifest.commit;

if ((manifest.packages ?? []).length === 0) {
  console.log("No release tags to push.");
  process.exit(0);
}

if (!targetCommit) {
  throw new Error("Release manifest is missing commit.");
}

const tags = manifest.packages.map(
  (pkg) => pkg.tag ?? `${pkg.name}@${pkg.version}`,
);

const existingRemoteTags = fetchRemoteTags(tags);

const toCreate = [];
const toPush = [];

for (const tag of tags) {
  if (existingRemoteTags.has(tag)) {
    continue;
  }

  if (!localTagExists(tag)) {
    toCreate.push(tag);
  } else if (getLocalTagTarget(tag) !== targetCommit) {
    throw new Error(
      `Local tag ${tag} already exists on ${getLocalTagTarget(tag)}, expected ${targetCommit}.`,
    );
  }

  toPush.push(tag);
}

for (const tag of toCreate) {
  execFileSync("git", ["tag", tag, targetCommit], { stdio: "inherit" });
}

if (toPush.length > 0) {
  execFileSync(
    "git",
    ["push", "origin", ...toPush.map((tag) => `refs/tags/${tag}`)],
    { stdio: "inherit" },
  );
}

if (toPush.length === 0) {
  console.log("All release tags already exist on origin.");
  appendSummary(
    "## Release tags\n\nAll release tags already existed on origin.",
  );
  process.exit(0);
}

const list = toPush.map((tag) => `- ${tag}`).join("\n");
console.log(`Pushed release tags:\n${list}`);
appendSummary(`## Release tags\n\nPushed:\n${list}`);

function localTagExists(tag) {
  return (
    spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
      stdio: "ignore",
    }).status === 0
  );
}

function getLocalTagTarget(tag) {
  return execFileSync("git", ["rev-list", "-n", "1", tag], {
    encoding: "utf8",
  }).trim();
}

function fetchRemoteTags(tagsToCheck) {
  const result = spawnSync(
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      ...tagsToCheck.map((t) => `refs/tags/${t}`),
    ],
    { encoding: "utf8" },
  );

  const existing = new Set();
  if (result.status === 0 && result.stdout) {
    for (const line of result.stdout.trim().split("\n")) {
      const ref = line.split("\t")[1];
      if (ref) {
        existing.add(ref.replace("refs/tags/", ""));
      }
    }
  }
  return existing;
}
