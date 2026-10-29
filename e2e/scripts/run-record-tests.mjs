#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditCassettes } from "./cassette-audit.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(E2E_DIR, "..");
const TMP_ROOT = path.join(E2E_DIR, ".bt-tmp");
const BUILD_DEPS_ARG = "--braintrust-build-deps";
const RUN_CONTEXT_DIR_ENV = "BRAINTRUST_E2E_RUN_CONTEXT_DIR";
const CASSETTE_MODE_ENV = "BRAINTRUST_E2E_CASSETTE_MODE";
const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const VITEST_COMMAND = path.join(
  E2E_DIR,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vp.cmd" : "vp",
);

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const shouldBuildDeps = rawArgs.includes(BUILD_DEPS_ARG);
const scenarioNames = rawArgs.filter((arg) => arg !== BUILD_DEPS_ARG);

for (const scenarioName of scenarioNames) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scenarioName)) {
    console.error(
      `[record] Expected scenario names like "trace-primitives-basic", got "${scenarioName}".`,
    );
    process.exit(1);
  }
  if (!existsSync(scenarioTestPath(scenarioName))) {
    console.error(`[record] No e2e scenario exists for "${scenarioName}".`);
    process.exit(1);
  }
}

if (shouldBuildDeps) {
  const buildResult = await runProcess(
    PNPM_COMMAND,
    ["exec", "turbo", "run", "build", "--filter=@braintrust/js-e2e-tests^..."],
    { cwd: REPO_ROOT, env: process.env },
  );
  if (buildResult.signal) {
    console.error(
      `[record] Build exited after receiving ${buildResult.signal}.`,
    );
    process.exit(1);
  }
  if (buildResult.code !== 0) {
    process.exit(buildResult.code ?? 1);
  }
}

const contextParent = process.env[RUN_CONTEXT_DIR_ENV];
await mkdir(contextParent || TMP_ROOT, { recursive: true });
const runContextDir = await mkdtemp(
  path.join(contextParent || TMP_ROOT, "record-context-"),
);

const result = await runVitest(scenarioNames, runContextDir);

try {
  if (result.code === 0) {
    await auditCassettes({
      e2eDir: E2E_DIR,
      runContextDir,
      reportPath: path.join(runContextDir, "results.json"),
      clean: true,
    });
  }
} finally {
  if (!contextParent) {
    await rm(runContextDir, { recursive: true, force: true });
  }
}

if (result.signal) {
  console.error(`[record] Vitest exited after receiving ${result.signal}.`);
  process.exit(1);
}
process.exit(result.code ?? 1);

function scenarioTestPath(scenarioName) {
  return path.join(E2E_DIR, "scenarios", scenarioName, "scenario.test.ts");
}

async function runVitest(scenarioNames, runContextDir) {
  const env = {
    ...process.env,
    [CASSETTE_MODE_ENV]: "record",
  };
  if (runContextDir) {
    env[RUN_CONTEXT_DIR_ENV] = runContextDir;
  }

  const scenarioPaths = scenarioNames.map(
    (scenarioName) => `scenarios/${scenarioName}/`,
  );
  const vitestArgs =
    scenarioPaths.length > 0
      ? ["run", "--no-file-parallelism", ...scenarioPaths, "--update"]
      : [
          "run",
          "--no-file-parallelism",
          ...(await defaultScenarioTestPaths()),
          "--update",
        ];
  vitestArgs.push(
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${path.join(runContextDir, "results.json")}`,
  );

  return await runProcess(VITEST_COMMAND, ["test", ...vitestArgs], {
    cwd: E2E_DIR,
    env,
  });
}

async function defaultScenarioTestPaths() {
  const entries = await readdir(path.join(E2E_DIR, "scenarios"), {
    withFileTypes: true,
  });
  const scenarioDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `scenarios/${entry.name}`);
  const scenarioPaths = (
    await Promise.all(
      scenarioDirs.map(async (dir) =>
        (await readdir(path.join(E2E_DIR, dir)))
          .filter((name) => name.endsWith(".test.ts"))
          .map((name) => `${dir}/${name}`),
      ),
    )
  )
    .flat()
    .sort();

  if (scenarioPaths.length === 0) {
    console.error("[record] No scenario test files found.");
    process.exit(1);
  }

  return scenarioPaths;
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: "inherit",
  });
  const forwardSigint = () => child.kill("SIGINT");
  const forwardSigterm = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forwardSigint);
      process.off("SIGTERM", forwardSigterm);
      resolve({ code, signal });
    });
  });
}
