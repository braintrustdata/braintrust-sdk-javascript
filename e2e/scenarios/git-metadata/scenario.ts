import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { init } from "braintrust";
import { getTestRunId, runMain } from "../../helpers/scenario-runtime";

const execFileAsync = promisify(execFile);
const gitMetadataSettings = {
  collect: "some" as const,
  fields: [
    "commit" as const,
    "branch" as const,
    "tag" as const,
    "dirty" as const,
    "author_name" as const,
    "author_email" as const,
    "commit_message" as const,
    "commit_time" as const,
  ],
};

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
  });
  return stdout.trim();
}

async function commit(
  repoDir: string,
  message: string,
  timestamp: string,
): Promise<string> {
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  });
  return await git(repoDir, ["rev-parse", "HEAD"]);
}

async function initializeRepository(): Promise<{
  baseCommit: string;
  repoDir: string;
}> {
  const fixtureDir = path.join(process.cwd(), ".git-metadata-fixture");
  const repoDir = path.join(fixtureDir, "repo");
  const remoteDir = path.join(fixtureDir, "remote.git");

  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(remoteDir, { recursive: true });

  await git(repoDir, ["init"]);
  await git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(repoDir, ["config", "user.name", "Braintrust Git Regression"]);
  await git(repoDir, ["config", "user.email", "git-regression@braintrust.dev"]);

  await writeFile(path.join(repoDir, "application.txt"), "seed\n");
  await commit(
    repoDir,
    "Deterministic seed commit",
    "2024-01-31T12:00:00+00:00",
  );

  await writeFile(path.join(repoDir, "application.txt"), "base\n");
  const baseCommit = await commit(
    repoDir,
    "Deterministic base commit",
    "2024-02-01T12:00:00+00:00",
  );
  await git(repoDir, ["tag", "git-regression-base"]);

  await git(remoteDir, ["init", "--bare"]);
  await git(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(repoDir, ["remote", "add", "origin", remoteDir]);
  await git(repoDir, ["push", "--set-upstream", "origin", "main"]);

  return { baseCommit, repoDir };
}

async function logRegressionSpan(
  experimentName: string,
  testRunId: string,
  gitRegressionCase: string,
): Promise<void> {
  const experiment = init({
    project: "e2e-git-metadata",
    experiment: experimentName,
    gitMetadataSettings,
    setCurrent: false,
    update: true,
  });
  const span = experiment.startSpan({
    name: "git-metadata-regression",
    event: {
      input: { case: gitRegressionCase },
      metadata: { gitRegressionCase, testRunId },
    },
  });
  span.log({ output: { status: "recorded" } });
  span.end();
  await experiment.flush();
}

async function main() {
  const testRunId = getTestRunId();
  const { baseCommit, repoDir } = await initializeRepository();
  process.chdir(repoDir);

  await logRegressionSpan("git-metadata-base", testRunId, "base");

  await git(repoDir, ["checkout", "-b", "feature/git-metadata-regression"]);
  await writeFile(path.join(repoDir, "application.txt"), "feature\n");
  const featureCommit = await commit(
    repoDir,
    "Deterministic feature commit",
    "2024-02-02T12:00:00+00:00",
  );
  await git(repoDir, ["tag", "git-regression-feature"]);
  await writeFile(path.join(repoDir, "application.txt"), "dirty feature\n");

  await logRegressionSpan("git-metadata-feature", testRunId, "feature-dirty");

  console.log(JSON.stringify({ baseCommit, featureCommit }));
}

runMain(main);
