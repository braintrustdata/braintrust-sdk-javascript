#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditCassettes } from "./cassette-audit.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(SCRIPT_DIR, "..");
const VITEST_COMMAND = path.join(
  E2E_DIR,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vp.cmd" : "vp",
);
const DEFAULT_OPENAI_CODEX_E2E_MODEL = "gpt-5.3-codex";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const updateSnapshots = rawArgs.includes("--update");
const cleanCassettes = rawArgs.includes("--clean-cassettes");
const checkCassettes = cleanCassettes || rawArgs.includes("--check-cassettes");
const shardArgIndex = rawArgs.findIndex(
  (arg) => arg === "--shard" || arg.startsWith("--shard="),
);
const shardArg = rawArgs[shardArgIndex];
const shardValue =
  shardArgIndex === -1
    ? null
    : shardArg === "--shard"
      ? rawArgs[shardArgIndex + 1]
      : shardArg.slice("--shard=".length);
if (shardArgIndex !== -1 && !shardValue) {
  console.error("[e2e] --shard requires a value in the form <index>/<count>.");
  process.exit(1);
}
const shardArgs = shardValue ? [`--shard=${shardValue}`] : [];
const scenarioArgs = rawArgs.filter(
  (arg, index) =>
    arg !== "--update" &&
    arg !== "--check-cassettes" &&
    arg !== "--clean-cassettes" &&
    index !== shardArgIndex &&
    !(shardArg === "--shard" && index === shardArgIndex + 1),
);
if (
  checkCassettes &&
  (shardValue ||
    updateSnapshots ||
    scenarioArgs.some(
      (name) =>
        !/^[a-z0-9][a-z0-9-]*$/.test(name) ||
        !existsSync(path.join(E2E_DIR, "scenarios", name, "scenario.test.ts")),
    ))
) {
  console.error(
    "[cassettes] Select whole scenarios by name; filters, sharding, and snapshot updates are not supported.",
  );
  process.exit(1);
}
const contextParent = process.env.BRAINTRUST_E2E_RUN_CONTEXT_DIR;
let auditDir;
if (checkCassettes) {
  const parent = contextParent || path.join(E2E_DIR, ".bt-tmp");
  await mkdir(parent, { recursive: true });
  auditDir = await mkdtemp(path.join(parent, "cassette-audit-"));
}
const reportPath = auditDir && path.join(auditDir, "results.json");
const testTargets =
  scenarioArgs.length > 0
    ? scenarioArgs.map((arg) => scenarioPathArg(arg))
    : [...(await defaultScenarioTestPaths()), "helpers"];
const vitestArgs = [
  "test",
  "run",
  "--run",
  ...testTargets,
  ...shardArgs,
  ...(updateSnapshots ? ["--update"] : []),
  ...(checkCassettes
    ? ["--reporter=default", "--reporter=json", `--outputFile=${reportPath}`]
    : []),
];
let exitCode;
try {
  const result = await runProcess(VITEST_COMMAND, vitestArgs, {
    cwd: E2E_DIR,
    env: {
      ...replayEnv(),
      ...(auditDir ? { BRAINTRUST_E2E_RUN_CONTEXT_DIR: auditDir } : {}),
    },
  });
  exitCode = result.code ?? 1;
  if (result.signal) {
    console.error(`[e2e] Vitest exited after receiving ${result.signal}.`);
    exitCode = 1;
  } else if (result.code === 0 && checkCassettes) {
    const { unused, skipped } = await auditCassettes({
      e2eDir: E2E_DIR,
      runContextDir: auditDir,
      reportPath,
      clean: cleanCassettes,
    });
    if ((!cleanCassettes && unused.length > 0) || skipped.length > 0) {
      exitCode = 1;
    }
  }
} finally {
  // Preserve explicitly requested trace records for the e2e summary.
  if (auditDir && !contextParent) {
    await rm(auditDir, { recursive: true, force: true });
  }
}
process.exit(exitCode);

function scenarioPathArg(arg) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(arg)) {
    return arg;
  }

  const scenarioDir = path.join(E2E_DIR, "scenarios", arg);
  return existsSync(path.join(scenarioDir, "scenario.test.ts"))
    ? `scenarios/${arg}/`
    : arg;
}

async function defaultScenarioTestPaths() {
  const entries = await readdir(path.join(E2E_DIR, "scenarios"), {
    withFileTypes: true,
  });
  const scenarioDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `scenarios/${entry.name}`);
  const testPaths = (
    await Promise.all(
      [...scenarioDirs, "helpers"].map(async (dir) =>
        (await readdir(path.join(E2E_DIR, dir)))
          .filter((name) => name.endsWith(".test.ts"))
          .map((name) => `${dir}/${name}`),
      ),
    )
  )
    .flat()
    .sort();

  if (testPaths.length === 0) {
    console.error("[e2e] No scenario test files found.");
    process.exit(1);
  }

  return testPaths;
}

function replayEnv() {
  const env = { ...process.env };
  env.BRAINTRUST_E2E_CASSETTE_MODE = "replay";
  env.OPENAI_CODEX_E2E_MODEL = DEFAULT_OPENAI_CODEX_E2E_MODEL;
  return env;
}

async function runProcess(command, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}
