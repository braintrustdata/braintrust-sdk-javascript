import { test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { E2E_TAGS } from "../../helpers/tags";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

test(
  "turbopack-auto-instrumentation: Next.js build output contains OpenAI instrumentation",
  { tags: [E2E_TAGS.hermetic] },
  async () => {
    await withScenarioHarness(async ({ runScenarioDir }) => {
      await runScenarioDir({ scenarioDir, timeoutMs: 180_000 });
    });
  },
);
