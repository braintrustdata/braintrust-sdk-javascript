import { readFileSync } from "node:fs";

const { packages = [] } = JSON.parse(
  readFileSync(".release-manifest.json", "utf8"),
);
const token = process.env.GITHUB_TOKEN;

if (packages.length === 0) {
  console.log("No released packages; no issue comments to post.");
  process.exit(0);
}

if (!token) {
  throw new Error("GITHUB_TOKEN must be set");
}

const pullReleases = new Map();

for (const pkg of packages) {
  const releaseResponse = await fetchGithub(
    `/repos/braintrustdata/braintrust-sdk-javascript/releases/tags/${encodeURIComponent(pkg.tag)}`,
    { method: "GET", allow404: true },
  );

  if (releaseResponse.status === 404) {
    console.warn(`GitHub release ${pkg.tag} does not exist; skipping.`);
    continue;
  }

  const release = await releaseResponse.json();
  for (const match of (release.body ?? "").matchAll(
    /https:\/\/github\.com\/braintrustdata\/braintrust-sdk-javascript\/pull\/(\d+)\b/g,
  )) {
    const pullNumber = Number(match[1]);
    if (!pullReleases.has(pullNumber)) {
      pullReleases.set(pullNumber, new Map());
    }
    pullReleases.get(pullNumber).set(pkg.tag, {
      label: `${pkg.name}@${pkg.version}`,
      url: release.html_url,
    });
  }
}

if (pullReleases.size === 0) {
  console.log("No pull request links were found in the GitHub releases.");
  process.exit(0);
}

const issueComments = new Map();

for (const [pullNumber, releases] of pullReleases) {
  const graphqlResponse = await fetchGithub("/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: `query ReleaseIssueComments($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 100) {
              nodes {
                number
                state
                repository {
                  nameWithOwner
                }
              }
            }
          }
        }
      }`,
      variables: {
        owner: "braintrustdata",
        repo: "braintrust-sdk-javascript",
        number: pullNumber,
      },
    }),
  });
  const payload = await graphqlResponse.json();

  if (payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL failed: ${payload.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  const issues =
    payload.data.repository.pullRequest?.closingIssuesReferences.nodes ?? [];
  for (const issue of issues) {
    if (
      issue.repository.nameWithOwner !==
        "braintrustdata/braintrust-sdk-javascript" ||
      issue.state !== "CLOSED"
    ) {
      continue;
    }

    if (!issueComments.has(issue.number)) {
      issueComments.set(issue.number, {
        pullNumbers: new Set(),
        releases: new Map(),
      });
    }

    const comment = issueComments.get(issue.number);
    comment.pullNumbers.add(pullNumber);
    for (const [tag, release] of releases) {
      comment.releases.set(tag, release);
    }
  }
}

if (issueComments.size === 0) {
  console.log(
    "Included pull requests did not close any same-repository issues.",
  );
  process.exit(0);
}

let posted = 0;

for (const [issueNumber, comment] of [...issueComments].sort(
  ([left], [right]) => left - right,
)) {
  const releases = [...comment.releases.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((release) => `- [${release.label}](${release.url})`)
    .join("\n");
  const pullRequests = [...comment.pullNumbers]
    .sort((left, right) => left - right)
    .map((pullNumber) => `#${pullNumber}`)
    .join(", ");

  await fetchGithub(
    `/repos/braintrustdata/braintrust-sdk-javascript/issues/${issueNumber}/comments`,
    {
      method: "POST",
      body: JSON.stringify({
        body: `A release containing the fix/implementation for this issue has been published:

${releases}

Included via ${pullRequests}.`,
      }),
    },
  );
  posted += 1;
  console.log(`Commented on issue #${issueNumber}.`);
}

console.log(`Posted ${posted} release issue comment(s).`);

async function fetchGithub(endpoint, options) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method: options.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
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
