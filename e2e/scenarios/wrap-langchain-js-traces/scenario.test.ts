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

import { assertLangchainTraces } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;

test(
  "wrap-langchain-js-traces captures invoke, chain, stream, and tool spans via BraintrustCallbackHandler",
  {
    timeout: TIMEOUT_MS,
  },
  async () => {
    await withScenarioHarness(async ({ events, payloads, runScenarioDir }) => {
      await runScenarioDir({ scenarioDir, timeoutMs: TIMEOUT_MS });

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
