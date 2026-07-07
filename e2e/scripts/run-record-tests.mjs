#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  process.platform === "win32" ? "vitest.cmd" : "vitest",
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

await mkdir(TMP_ROOT, { recursive: true });
const runContextDir = await mkdtemp(path.join(TMP_ROOT, "record-context-"));

const result = await runVitest(scenarioNames, runContextDir);

try {
  if (result.code === 0) {
    await cleanupStaleCassettes(
      scenarioNames,
      await readRunContextRecords(runContextDir),
    );
  }
} finally {
  await rm(runContextDir, { recursive: true, force: true });
}

if (result.signal) {
  console.error(`[record] Vitest exited after receiving ${result.signal}.`);
  process.exit(1);
}
process.exit(result.code ?? 1);

function scenarioTestPath(scenarioName) {
  return path.join(E2E_DIR, "scenarios", scenarioName, "scenario.test.ts");
}

async function readRunContextRecords(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const records = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith("run-context-") ||
      !entry.name.endsWith(".ndjson")
    ) {
      continue;
    }

    const raw = await readFile(path.join(dir, entry.name), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (record && typeof record === "object") {
          records.push(record);
        }
      } catch {
        console.error(
          `[record] Ignoring malformed run-context line in ${entry.name}.`,
        );
      }
    }
  }
  return records;
}

async function cleanupStaleCassettes(scenarioNames, records) {
  const { createJsonFileStore } = await import("@braintrust/seinfeld");
  const variantsByScenario = new Map();
  for (const record of records) {
    if (
      typeof record.scenarioDirName !== "string" ||
      typeof record.variantKey !== "string" ||
      !record.variantKey.trim()
    ) {
      continue;
    }

    const variants =
      variantsByScenario.get(record.scenarioDirName) ?? new Set();
    variants.add(record.variantKey);
    variantsByScenario.set(record.scenarioDirName, variants);
  }

  const cleanupScenarioNames =
    scenarioNames.length > 0 ? scenarioNames : [...variantsByScenario.keys()];

  for (const scenarioName of cleanupScenarioNames) {
    const cassetteDir = path.join(
      E2E_DIR,
      "scenarios",
      scenarioName,
      "__cassettes__",
    );
    const variantsToKeep = variantsByScenario.get(scenarioName);
    if (!variantsToKeep || variantsToKeep.size === 0) {
      continue;
    }

    const variantKeys = await cassetteArtifactVariantKeys(cassetteDir);
    const store = createJsonFileStore({ rootDir: cassetteDir });

    let removedCount = 0;
    for (const variantKey of variantKeys) {
      if (variantsToKeep.has(variantKey)) {
        continue;
      }

      await store.delete(variantKey);
      removedCount++;
    }

    if (removedCount > 0) {
      console.error(
        `[record] Removed ${removedCount} stale cassette artifact(s) in ${scenarioName}.`,
      );
    }
  }
}

async function cassetteArtifactVariantKeys(cassetteDir) {
  let entries;
  try {
    entries = await readdir(cassetteDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const variantKeys = new Set();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".cassette.json")) {
      variantKeys.add(entry.name.slice(0, -".cassette.json".length));
    } else if (entry.isDirectory() && entry.name.endsWith(".cassette.blobs")) {
      variantKeys.add(entry.name.slice(0, -".cassette.blobs".length));
    }
  }
  return [...variantKeys].sort();
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
    (scenarioName) => `scenarios/${scenarioName}/scenario.test.ts`,
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

  return await runProcess(VITEST_COMMAND, vitestArgs, {
    cwd: E2E_DIR,
    env,
  });
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
