import { readFileSync } from "node:fs";

import { extractReleaseNotes, parseArgs } from "./_shared.mjs";

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
  } else {
    await fetchGithub(`/repos/${repository}/releases`, token, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag,
        name: pkg.release_title ?? tag,
        body:
          pkg.release_body ??
          extractReleaseNotes(pkg.dir, pkg.name, pkg.version),
        draft: false,
        prerelease: false,
        generate_release_notes: false,
      }),
    }).then((response) => response.json());

    console.log(`Created GitHub release for ${tag}`);
  }
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
