import { existsSync, readFileSync } from "node:fs";

import { escapeRegExp, parseArgs } from "./_shared.mjs";

const args = parseArgs();
const manifestPath = args.manifest ?? ".release-manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;

if (!token || !repository) {
  throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
}

if ((manifest.packages ?? []).length === 0) {
  console.log("No GitHub releases to create.");
  process.exit(0);
}

for (const pkg of manifest.packages) {
  const tag = pkg.tag ?? `${pkg.name}@${pkg.version}`;
  const existing = await fetchGithub(
    `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    token,
    { method: "GET", allow404: true },
  );

  if (existing.status === 200) {
    console.log(`GitHub release already exists for ${tag}`);
    continue;
  }

  await fetchGithub(`/repos/${repository}/releases`, token, {
    method: "POST",
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: extractReleaseNotes(pkg.dir, pkg.name, pkg.version),
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    }),
  });

  console.log(`Created GitHub release for ${tag}`);
}

function extractReleaseNotes(relativeDir, packageName, version) {
  const changelogPath = `${relativeDir}/CHANGELOG.md`;
  if (!existsSync(changelogPath)) {
    return `Published ${packageName}@${version}.`;
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const heading = new RegExp(`^##\\s+${escapeRegExp(version)}\\s*$`, "m");
  const match = heading.exec(changelog);
  if (!match) {
    return `Published ${packageName}@${version}.`;
  }

  const start = match.index;
  const afterHeading = changelog.slice(start);
  const nextHeading = afterHeading.slice(match[0].length).search(/^##\s+/m);
  const section =
    nextHeading === -1
      ? afterHeading
      : afterHeading.slice(0, match[0].length + nextHeading);

  return `# ${packageName}\n\n${section.trim()}`;
}

async function fetchGithub(endpoint, authToken, options) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method: options.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body,
  });

  if (options.allow404 && response.status === 404) {
    return response;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${options.method} ${endpoint} failed: ${response.status} ${body}`,
    );
  }

  return response;
}
