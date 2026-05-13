import { test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 180_000;

test(
  "turbopack-auto-instrumentation: Next.js build output contains OpenAI instrumentation",
  async () => {
    await withScenarioHarness(async ({ runScenarioDir }) => {
      await runScenarioDir({ scenarioDir, timeoutMs: TIMEOUT_MS });
    });
  },
  TIMEOUT_MS,
);
