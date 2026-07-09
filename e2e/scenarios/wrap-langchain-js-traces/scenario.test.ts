import { expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";

import { assertLangchainTraces } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 90_000;
const scenarios = await Promise.all(
  [
    {
      coreDependencyName: "langchain-core-v1",
      openAIDependencyName: "langchain-openai-v1",
      variantKey: "wrap-langchain-js-traces-v1",
    },
    {
      coreDependencyName: "langchain-core-v1-latest",
      openAIDependencyName: "langchain-openai-v1-latest",
      variantKey: "wrap-langchain-js-traces-v1-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.openAIDependencyName,
    ),
  })),
);

for (const scenario of scenarios) {
  test(
    `wrap-langchain-js-traces captures invoke, chain, stream, and tool spans via BraintrustCallbackHandler (${scenario.version})`,
    {
      timeout: TIMEOUT_MS,
    },
    async () => {
      await withScenarioHarness(async ({ events, runScenarioDir }) => {
        await runScenarioDir({
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
          env: {
            LANGCHAIN_CORE_PACKAGE_NAME: scenario.coreDependencyName,
            LANGCHAIN_OPENAI_PACKAGE_NAME: scenario.openAIDependencyName,
          },
          runContext: {
            variantKey: scenario.variantKey,
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
          resolveFileSnapshotPath(
            import.meta.url,
            `${scenario.variantKey}.span-tree.json`,
          ),
        );
      });
    },
  );
}
