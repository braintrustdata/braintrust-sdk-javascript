import { readFileSync } from "node:fs";

import { parseArgs, writeGithubOutput } from "./_shared.mjs";

const args = parseArgs();
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const base = args.base;
const head = args.head;
const title = args.title;
const body = args["body-file"]
  ? readFileSync(args["body-file"], "utf8")
  : (args.body ?? "");

if (!repository || !token) {
  throw new Error(
    "GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) are required",
  );
}

if (!base || !head || !title || !body.trim()) {
  throw new Error("--base, --head, --title, and a non-empty body are required");
}

const [owner] = repository.split("/");
const existingPullRequest = await findPullRequest(
  repository,
  owner,
  base,
  head,
);

let pullRequest;
let action;

if (!existingPullRequest) {
  pullRequest = await request(`/repos/${repository}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({
      base,
      body,
      head,
      title,
    }),
  });
  action = "created";
} else if (
  existingPullRequest.title !== title ||
  existingPullRequest.body !== body ||
  existingPullRequest.base?.ref !== base
) {
  pullRequest = await request(
    `/repos/${repository}/pulls/${existingPullRequest.number}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({
        base,
        body,
        title,
      }),
    },
  );
  action = "updated";
} else {
  pullRequest = existingPullRequest;
  action = "existing";
}

writeGithubOutput("action", action);
writeGithubOutput("number", pullRequest.number);
writeGithubOutput("url", pullRequest.html_url);
writeGithubOutput("title", pullRequest.title);

console.log(
  `${action} pull request #${pullRequest.number}: ${pullRequest.html_url}`,
);

async function findPullRequest(
  currentRepository,
  currentOwner,
  currentBase,
  currentHead,
) {
  const headQuery = encodeURIComponent(`${currentOwner}:${currentHead}`);
  const baseQuery = encodeURIComponent(currentBase);
  const pullRequests = await request(
    `/repos/${currentRepository}/pulls?state=open&base=${baseQuery}&head=${headQuery}&per_page=1`,
    token,
    { method: "GET" },
  );

  return pullRequests[0] ?? null;
}

async function request(endpoint, authToken, options) {
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

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `${options.method} ${endpoint} failed: ${response.status} ${errorBody}`,
    );
  }

  return response.json();
}
