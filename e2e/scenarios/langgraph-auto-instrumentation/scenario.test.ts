import { expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { assertLangGraphAutoInstrumentation } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 120_000;

test(
  "langgraph auto-instrumentation captures spans via the braintrust hook",
  {
    timeout: TIMEOUT_MS,
  },
  async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for this e2e scenario");
    }

    await withScenarioHarness(
      async ({ events, payloads, runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: "scenario.mjs",
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });

        const summaries = assertLangGraphAutoInstrumentation({
          capturedEvents: events(),
          payloads: payloads(),
        });

        await expect(
          formatJsonFileSnapshot(summaries.spanSummary),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "span-events.json"),
        );
        await expect(
          formatJsonFileSnapshot(summaries.payloadSummary),
        ).toMatchFileSnapshot(
          resolveFileSnapshotPath(import.meta.url, "log-payloads.json"),
        );
      },
    );
  },
);
