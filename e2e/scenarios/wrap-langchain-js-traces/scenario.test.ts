import { expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";

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
  },
  async () => {
    await withScenarioHarness(async ({ events, runScenarioDir }) => {
      await runScenarioDir({
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
        runContext: {
          variantKey: VARIANT_KEY,
          originalScenarioDir,
        },
      });

      const spanTree = assertLangchainTraces({
        capturedEvents: events(),
        rootName: "langchain-wrapper-root",
        scenarioName: "wrap-langchain-js-traces",
      });

      await matchSpanTreeSnapshot(
        spanTree,
        resolveFileSnapshotPath(import.meta.url, "span-tree.json"),
      );
    });
  },
);
