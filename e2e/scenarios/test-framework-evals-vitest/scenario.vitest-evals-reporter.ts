import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveScenarioDir } from "../../helpers/scenario-harness";
import {
  getTestRunId,
  runMain,
  runNodeSubprocess,
} from "../../helpers/scenario-runtime";

const require = createRequire(import.meta.url);
const scenarioDir = resolveScenarioDir(import.meta.url);

async function findVitestBin(): Promise<string> {
  const entryPath = require.resolve("vitest");
  let dir = path.dirname(entryPath);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "vitest.mjs");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep walking upward.
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not find vitest.mjs");
}

async function main() {
  const vitestCliPath = await findVitestBin();
  const testRunId = getTestRunId();

  await runNodeSubprocess({
    args: [
      vitestCliPath,
      "run",
      "--config",
      "vitest.runner-evals-reporter.config.mts",
    ],
    cwd: scenarioDir,
    env: {
      BRAINTRUST_E2E_RUN_ID: testRunId,
    },
    timeoutMs: 60_000,
  });
}

runMain(main);
