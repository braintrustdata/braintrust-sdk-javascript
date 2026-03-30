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

// Resolve the vitest.mjs bin by finding the package root via the main entry.
async function findVitestBin(packageName: string): Promise<string> {
  const entryPath = require.resolve(packageName);
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
  throw new Error(`Could not find vitest.mjs for ${packageName}`);
}

async function main() {
  const vitestCliPath = await findVitestBin("vitest-v4");
  const testRunId = getTestRunId();

  await runNodeSubprocess({
    args: [vitestCliPath, "run", "--config", "vitest.runner-v4.config.mts"],
    cwd: scenarioDir,
    env: {
      BRAINTRUST_E2E_RUN_ID: testRunId,
    },
    timeoutMs: 60_000,
  });
}

runMain(main);
