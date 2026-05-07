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
import { cassetteTagsFor } from "../../helpers/tags";

import { assertLangchainTraces } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const VARIANT_KEY = "wrap-langchain-js-traces";
const TIMEOUT_MS = 90_000;

test(
  "wrap-langchain-js-traces captures invoke, chain, stream, and tool spans via BraintrustCallbackHandler",
  {
    timeout: TIMEOUT_MS,
    tags: cassetteTagsFor(import.meta.url, VARIANT_KEY),
  },
  async () => {
    await withScenarioHarness(async ({ events, payloads, runScenarioDir }) => {
      await runScenarioDir({
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
        runContext: {
          variantKey: VARIANT_KEY,
          originalScenarioDir,
        },
      });

      const summaries = assertLangchainTraces({
        capturedEvents: events(),
        payloads: payloads(),
        rootName: "langchain-wrapper-root",
        scenarioName: "wrap-langchain-js-traces",
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
    });
  },
);
