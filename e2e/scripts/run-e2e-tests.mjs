#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(SCRIPT_DIR, "..");
const VITEST_COMMAND = path.join(
  E2E_DIR,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);
const DEFAULT_OPENAI_CODEX_E2E_MODEL = "gpt-5.1-codex-mini";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const updateSnapshots = rawArgs.includes("--update");
const scenarioArgs = rawArgs.filter((arg) => arg !== "--update");
const testTargets =
  scenarioArgs.length > 0
    ? scenarioArgs.map((arg) => scenarioPathArg(arg))
    : await defaultScenarioTestPaths();
const vitestArgs = [
  "run",
  "--run",
  ...testTargets,
  ...(updateSnapshots ? ["--update"] : []),
];
const result = await runProcess(VITEST_COMMAND, vitestArgs, {
  cwd: E2E_DIR,
  env: replayEnv(),
});

if (result.signal) {
  console.error(`[e2e] Vitest exited after receiving ${result.signal}.`);
  process.exit(1);
}
process.exit(result.code ?? 1);

function scenarioPathArg(arg) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(arg)) {
    return arg;
  }

  const scenarioPath = path.join(E2E_DIR, "scenarios", arg, "scenario.test.ts");
  return existsSync(scenarioPath) ? `scenarios/${arg}/scenario.test.ts` : arg;
}

async function defaultScenarioTestPaths() {
  const entries = await readdir(path.join(E2E_DIR, "scenarios"), {
    withFileTypes: true,
  });
  const scenarioPaths = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `scenarios/${entry.name}/scenario.test.ts`)
    .filter((scenarioPath) => existsSync(path.join(E2E_DIR, scenarioPath)))
    .sort();

  if (scenarioPaths.length === 0) {
    console.error("[e2e] No scenario test files found.");
    process.exit(1);
  }

  return scenarioPaths;
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
