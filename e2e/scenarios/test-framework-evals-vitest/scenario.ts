import { createRequire } from "node:module";
import { resolveScenarioDir } from "../../helpers/scenario-harness";
import {
  getTestRunId,
  runMain,
  runNodeSubprocess,
} from "../../helpers/scenario-runtime";

const require = createRequire(import.meta.url);
const scenarioDir = resolveScenarioDir(import.meta.url);
const vitestPackageName = process.env.VITEST_PACKAGE_NAME ?? "vitest-v2-latest";
const vitestCliPath = require.resolve(`${vitestPackageName}/vitest.mjs`);

async function main() {
  const testRunId = getTestRunId();

  await runNodeSubprocess({
    args: [vitestCliPath, "run", "--config", "vitest.runner.config.mts"],
    cwd: scenarioDir,
    env: {
      BRAINTRUST_E2E_RUN_ID: testRunId,
      VITEST_CONFIG_PACKAGE_NAME: vitestPackageName,
    },
    timeoutMs: 60_000,
  });
}

runMain(main);
