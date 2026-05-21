import {
  type GitMetadataSettingsType as GitMetadataSettings,
  type RepoInfoType as RepoInfo,
} from "./generated_types";
import { debugLogger } from "./debug-logger";
import { simpleGit } from "simple-git";
import { defaultGitMetadataSettings } from "../util/git_fields";

const COMMON_BASE_BRANCHES = ["main", "master", "develop"];

/**
 * Information about the current HEAD of the repo.
 */
export async function currentRepo() {
  try {
    const git = simpleGit();
    if (await git.checkIsRepo()) {
      return git;
    } else {
      return null;
    }
  } catch {
    return null;
  }
}

let _baseBranch: {
  remote: string;
  branch: string;
} | null = null;

async function getBaseBranch(remote: string | undefined = undefined) {
  if (_baseBranch === null) {
    const git = await currentRepo();
    if (git === null) {
      throw new Error("Not in a git repo");
    }

    const remoteName = remote ?? (await git.getRemotes())[0]?.name;
    if (!remoteName) {
      throw new Error("No remote found");
    }

    let branch = null;

    // NOTE: This should potentially be configuration that we derive from the project,
    // instead of spending a second or two computing it each time we run an experiment.

    // To speed this up in the short term, we pick from a list of common names
    // and only fall back to the remote origin if required.
    const repoBranches = new Set((await git.branchLocal()).all);
    const matchingBaseBranches = COMMON_BASE_BRANCHES.filter((b) =>
      repoBranches.has(b),
    );
    if (matchingBaseBranches.length === 1) {
      branch = matchingBaseBranches[0];
    } else {
      try {
        const remoteInfo = await git.remote(["show", remoteName]);
        if (!remoteInfo) {
          throw new Error(`Could not find remote ${remoteName}`);
        }
        const match = remoteInfo.match(/\s*HEAD branch:\s*(.*)$/m);
        if (!match) {
          throw new Error(`Could not find HEAD branch in remote ${remoteName}`);
        }
        branch = match[1];
      } catch {
        branch = "main";
      }
    }

    _baseBranch = { remote: remoteName, branch };
  }

  return _baseBranch;
}

async function getBaseBranchAncestor(remote: string | undefined = undefined) {
  const git = await currentRepo();
  if (git === null) {
    throw new Error("Not in a git repo");
  }

  const { remote: remoteName, branch: baseBranch } =
    await getBaseBranch(remote);

  const isDirty = (await git.diffSummary()).files.length > 0;
  const head = isDirty ? "HEAD" : "HEAD^";

  try {
    const ancestor = await git.raw([
      "merge-base",
      head,
      `${remoteName}/${baseBranch}`,
    ]);
    return ancestor.trim();
  } catch {
    /*
    console.warn(
      `Warning: Could not find a common ancestor with ${remoteName}/${baseBranch}`
    );
    */
    return undefined;
  }
}

export async function getPastNAncestors(
  n: number = 1000,
  remote: string | undefined = undefined,
) {
  const git = await currentRepo();
  if (git === null) {
    return [];
  }

  let ancestor = undefined;
  try {
    ancestor = await getBaseBranchAncestor(remote);
  } catch (e) {
    debugLogger.warn(
      "Skipping git metadata. This is likely because the repository has not been published to a remote yet.",
      `${e}`,
    );
  }
  if (!ancestor) {
    return [];
  }
  const commits = await git.log({ from: ancestor, to: "HEAD", maxCount: n });
  return commits.all.slice(0, n).map((c) => c.hash);
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function truncateToByteLimit(s: string, byteLimit: number = 65536): string {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length <= byteLimit) {
    return s;
  }

  const truncated = encoded.subarray(0, byteLimit);
  // Decode back to string, automatically ignoring any incomplete character at the end
  return new TextDecoder().decode(truncated);
}

export async function getRepoInfo(settings?: GitMetadataSettings) {
  const resolvedSettings = settings ?? defaultGitMetadataSettings();
  if (resolvedSettings.collect === "none") {
    return undefined;
  }

  const repo = await repoInfo();
  if (!repo || resolvedSettings.collect === "all") {
    return repo;
  }

  let sanitized: RepoInfo = {};
  resolvedSettings.fields?.forEach((field) => {
    sanitized = { ...sanitized, [field]: repo[field] };
  });

  return sanitized;
}

async function repoInfo() {
  const git = await currentRepo();
  if (git === null) {
    return undefined;
  }

  let commit = undefined;
  let commit_message = undefined;
  let commit_time = undefined;
  let author_name = undefined;
  let author_email = undefined;
  let tag = undefined;
  let branch = undefined;
  let git_diff = undefined;

  const dirty = (await git.diffSummary()).files.length > 0;

  commit = await attempt(async () => await git.revparse(["HEAD"]));
  commit_message = await attempt(async () =>
    (await git.raw(["log", "-1", "--pretty=%B"])).trim(),
  );
  commit_time = await attempt(async () =>
    (await git.raw(["log", "-1", "--pretty=%cI"])).trim(),
  );
  author_name = await attempt(async () =>
    (await git.raw(["log", "-1", "--pretty=%aN"])).trim(),
  );
  author_email = await attempt(async () =>
    (await git.raw(["log", "-1", "--pretty=%aE"])).trim(),
  );
  tag = await attempt(async () =>
    (await git.raw(["describe", "--tags", "--exact-match", "--always"])).trim(),
  );

  branch = await attempt(async () =>
    (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
  );

  if (dirty) {
    git_diff = await attempt(async () =>
      truncateToByteLimit(await git.raw(["--no-ext-diff", "diff", "HEAD"])),
    );
  }

  return {
    commit,
    branch,
    tag,
    dirty,
    author_name,
    author_email,
    commit_message,
    commit_time,
    git_diff,
  };
}
