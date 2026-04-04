import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  NPM_REGISTRY,
  appendSummary,
  filterPublishableReleases,
  parseArgs,
  writeGithubOutput,
} from "./_shared.mjs";

/**
 * Checks whether a canary publish is needed for the current HEAD commit.
 *
 * 1. Filters publishable packages with pending changesets.
 * 2. For each, queries the npm registry for the `canary` dist-tag version.
 *    If that version already ends with the current short commit hash, the
 *    package is considered already published.
 * 3. If any package still needs publishing, verifies the latest CI run
 *    on the target branch succeeded before allowing the publish.
 *
 * Outputs `should_publish=false` when no publish is needed or CI has not
 * passed, so the workflow can skip downstream steps.
 */

const CI_WORKFLOW_FILE = "checks.yaml";

const args = parseArgs();
const statusPath = args["status-file"] ?? ".changeset-status.json";
const branch = args.branch ?? "main";

const commitHash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();

console.log(`Current HEAD commit: ${commitHash}`);

const status = JSON.parse(readFileSync(statusPath, "utf8"));
const releases = filterPublishableReleases(status);

if (releases.length === 0) {
  console.log("No publishable packages have pending changesets.");
  writeGithubOutput("should_publish", "false");
  appendSummary(
    "## Canary check\n\nNo pending changesets — nothing to publish.",
  );
  process.exit(0);
}

console.log(`Checking canary dist-tags for ${releases.length} package(s)...\n`);

let allAlreadyPublished = true;
const results = [];

for (const release of releases) {
  let canaryVersion = null;
  try {
    canaryVersion = execFileSync(
      "npm",
      ["view", release.name, "dist-tags.canary", "--registry", NPM_REGISTRY],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch {
    // Package has no canary dist-tag or doesn't exist on npm yet.
  }

  const alreadyPublished =
    canaryVersion != null &&
    canaryVersion !== "" &&
    canaryVersion.endsWith(`.${commitHash}`);

  if (!alreadyPublished) {
    allAlreadyPublished = false;
  }

  results.push({
    name: release.name,
    canaryVersion: canaryVersion || "(none)",
    alreadyPublished,
  });
}

for (const r of results) {
  const label = r.alreadyPublished ? "✓ already published" : "✗ needs publish";
  console.log(`  ${r.name}: ${label} (canary: ${r.canaryVersion})`);
}

if (allAlreadyPublished) {
  writeGithubOutput("should_publish", "false");
  const list = results.map((r) => `- ${r.name}@${r.canaryVersion}`).join("\n");
  appendSummary(
    `## Canary check\n\nAll packages already have canary for commit \`${commitHash}\`:\n${list}\n\nSkipping publish.`,
  );
  console.log(
    `\nAll packages already have canary for commit ${commitHash}. Skipping.`,
  );
  process.exit(0);
}

// Verify the latest CI run on the target branch succeeded before publishing.
const ciResult = await checkCiStatus(branch);

if (!ciResult.passed) {
  writeGithubOutput("should_publish", "false");
  appendSummary(
    `## Canary check\n\nCanary publish skipped — CI gate failed.\n\n${ciResult.reason}`,
  );
  console.log(`\nCanary publish skipped: ${ciResult.reason}`);
  process.exit(0);
}

console.log(`\nCI gate passed: ${ciResult.reason}`);

writeGithubOutput("should_publish", "true");
const list = results
  .filter((r) => !r.alreadyPublished)
  .map((r) => `- ${r.name} (current canary: ${r.canaryVersion})`)
  .join("\n");
appendSummary(
  `## Canary check\n\nNew canary needed for commit \`${commitHash}\`:\n${list}`,
);
console.log(`\nCanary publish needed for commit ${commitHash}.`);

async function checkCiStatus(targetBranch) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;

  if (!token || !repository) {
    console.log(
      "GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping CI status check.",
    );
    return { passed: true, reason: "CI check skipped (no credentials)." };
  }

  const url = `https://api.github.com/repos/${repository}/actions/workflows/${CI_WORKFLOW_FILE}/runs?branch=${encodeURIComponent(targetBranch)}&status=completed&per_page=1`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    return {
      passed: false,
      reason: `Failed to query CI status: ${response.status} ${body}`,
    };
  }

  const data = await response.json();
  const run = data.workflow_runs?.[0];

  if (!run) {
    return {
      passed: false,
      reason: `No completed ${CI_WORKFLOW_FILE} run found on \`${targetBranch}\`.`,
    };
  }

  if (run.conclusion !== "success") {
    return {
      passed: false,
      reason: `Latest ${CI_WORKFLOW_FILE} run on \`${targetBranch}\` concluded with \`${run.conclusion}\` (${run.html_url}).`,
    };
  }

  return {
    passed: true,
    reason: `Latest ${CI_WORKFLOW_FILE} run on \`${targetBranch}\` succeeded (${run.html_url}).`,
  };
}
