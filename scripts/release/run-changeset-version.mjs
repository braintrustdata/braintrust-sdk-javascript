import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  escapeRegExp,
  listWorkspacePackageDirs,
  readPackage,
  repoPath,
} from "./_shared.mjs";

const workspacePackagesByName = new Map(
  listWorkspacePackageDirs().map((dir) => {
    const manifest = readPackage(dir);
    return [manifest.name, dir];
  }),
);

const statusFile = path.join(
  mkdtempSync(path.join(os.tmpdir(), "changeset-status-")),
  "status.json",
);

runCommand("pnpm", ["exec", "changeset", "status", "--output", statusFile]);

const status = JSON.parse(readFileSync(statusFile, "utf8"));
const releasePackageNames = new Set(
  (status.releases ?? []).map((release) => release.name),
);

runCommand("pnpm", ["exec", "changeset", "version", ...process.argv.slice(2)]);

for (const packageName of releasePackageNames) {
  const workspacePackageDir = workspacePackagesByName.get(packageName);
  if (!workspacePackageDir) {
    continue;
  }

  const manifest = readPackage(workspacePackageDir);
  const changelogPath = repoPath(workspacePackageDir, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    continue;
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const nextChangelog = rewriteVersionSection(changelog, manifest.version);
  if (nextChangelog !== changelog) {
    writeFileSync(changelogPath, nextChangelog, "utf8");
  }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoPath(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function rewriteVersionSection(changelog, version) {
  const heading = new RegExp(`^##\\s+${escapeRegExp(version)}\\s*$`, "m");
  const match = heading.exec(changelog);
  if (!match) {
    return changelog;
  }

  const sectionStart = match.index;
  const bodyStart = sectionStart + match[0].length;
  const remaining = changelog.slice(bodyStart);
  const nextHeadingOffset = remaining.search(/^##\s+/m);
  const sectionEnd =
    nextHeadingOffset === -1 ? changelog.length : bodyStart + nextHeadingOffset;
  const body = changelog.slice(bodyStart, sectionEnd);
  const entries = extractEntries(body).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );

  if (entries.length === 0) {
    return changelog;
  }

  const replacement = `${match[0]}\n\n${entries.join("\n")}\n\n`;
  return `${changelog.slice(0, sectionStart)}${replacement}${changelog.slice(sectionEnd)}`;
}

function extractEntries(sectionBody) {
  const entries = [];
  let currentEntry = "";

  for (const line of sectionBody.split("\n")) {
    if (!line.trim() || line.startsWith("### ")) {
      continue;
    }

    if (line.startsWith("- ")) {
      if (currentEntry) {
        entries.push(currentEntry);
      }
      currentEntry = line.trim();
      continue;
    }

    if (currentEntry) {
      currentEntry = `${currentEntry} ${line.trim()}`;
    }
  }

  if (currentEntry) {
    entries.push(currentEntry);
  }

  return entries;
}
