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
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { assertLangGraphAutoInstrumentation } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;

test(
  "langgraph auto-instrumentation captures spans via the braintrust hook",
  {
    timeout: TIMEOUT_MS,
  },
  async () => {
    await withScenarioHarness(
      async ({ events, payloads, runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: "scenario.mjs",
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: {
            variantKey: "langgraph-auto-hook",
            originalScenarioDir,
          },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });

        const summaries = assertLangGraphAutoInstrumentation({
          capturedEvents: events(),
          payloads: payloads(),
        });

        await matchSpanTreeSnapshot(
          summaries.spanTree,
          resolveFileSnapshotPath(import.meta.url, "span-tree.json"),
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
