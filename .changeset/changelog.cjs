const {
  getInfo,
  getInfoFromPullRequest,
} = require("@changesets/get-github-info");
const { config } = require("dotenv");

config({ quiet: true });

function readEnv() {
  return {
    githubServerUrl: process.env.GITHUB_SERVER_URL || "https://github.com",
    githubToken: process.env.GITHUB_TOKEN || "",
  };
}

function getIgnoredAuthors(options) {
  return new Set(options.ignoredAuthors.map((author) => author.toLowerCase()));
}

function normalizeSummary(summary) {
  let prFromSummary;
  let commitFromSummary;
  const usersFromSummary = [];

  const text = summary
    .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/gim, (_, pr) => {
      const parsed = Number(pr);
      if (!Number.isNaN(parsed)) {
        prFromSummary = parsed;
      }
      return "";
    })
    .replace(/^\s*commit:\s*([^\s]+)/gim, (_, commit) => {
      commitFromSummary = commit;
      return "";
    })
    .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, (_, user) => {
      usersFromSummary.push(user);
      return "";
    })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  return { text, prFromSummary, commitFromSummary, usersFromSummary };
}

function uniqueUsers(users) {
  const seen = new Set();
  const result = [];

  for (const user of users) {
    const normalized = user.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function formatThanks(users, ignoredAuthors) {
  const externalUsers = uniqueUsers(users).filter(
    (user) => !ignoredAuthors.has(user),
  );

  if (externalUsers.length === 0) {
    return "";
  }

  return ` Thanks ${externalUsers.map((user) => `@${user}`).join(", ")}!`;
}

async function readGithubInfo({
  repo,
  prFromSummary,
  commitFromSummary,
  fallbackCommit,
  canQueryGithub,
}) {
  if (prFromSummary !== undefined) {
    if (!canQueryGithub) {
      return { pull: prFromSummary, user: null };
    }

    const info = await getInfoFromPullRequest({ repo, pull: prFromSummary });
    return { pull: prFromSummary, user: info.user };
  }

  const commit = commitFromSummary || fallbackCommit;
  if (!commit || !canQueryGithub) {
    return { pull: null, user: null };
  }

  const info = await getInfo({ repo, commit });
  return { pull: info.pull, user: info.user };
}

const changelogFunctions = {
  async getReleaseLine(changeset, _type, options) {
    if (!options?.repo) {
      throw new Error(
        'Please provide a repo to this changelog generator like this:\n"changelog": ["./.changeset/changelog.cjs", { "repo": "org/repo" }]',
      );
    }

    const { githubServerUrl, githubToken } = readEnv();
    const ignoredAuthors = getIgnoredAuthors(options);
    const { text, prFromSummary, commitFromSummary, usersFromSummary } =
      normalizeSummary(changeset.summary);

    const info = await readGithubInfo({
      repo: options.repo,
      prFromSummary,
      commitFromSummary,
      fallbackCommit: changeset.commit,
      canQueryGithub: Boolean(githubToken),
    });

    const users = usersFromSummary.length
      ? usersFromSummary
      : info.user
        ? [info.user]
        : [];
    const thanks = formatThanks(users, ignoredAuthors);
    const pullUrl = info.pull
      ? ` (${githubServerUrl}/${options.repo}/pull/${info.pull})`
      : "";

    return `- ${text}${thanks}${pullUrl}`;
  },

  async getDependencyReleaseLine(_changesets, dependenciesUpdated) {
    if (dependenciesUpdated.length === 0) {
      return "";
    }

    const dependencies = dependenciesUpdated
      .map((dependency) => `${dependency.name}@${dependency.newVersion}`)
      .sort((left, right) => left.localeCompare(right));

    return `- Updated dependencies: ${dependencies.join(", ")}`;
  },
};

module.exports = changelogFunctions;
