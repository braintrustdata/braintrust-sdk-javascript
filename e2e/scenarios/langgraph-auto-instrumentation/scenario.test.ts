import { expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
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
const scenarios = await Promise.all(
  [
    {
      coreDependencyName: "langchain-core-v1",
      langgraphDependencyName: "langchain-langgraph-v1",
      openAIDependencyName: "langchain-openai-v1",
      variantKey: "langgraph-v1",
    },
    {
      coreDependencyName: "langchain-core-v1-latest",
      langgraphDependencyName: "langchain-langgraph-v1-latest",
      openAIDependencyName: "langchain-openai-v1-latest",
      variantKey: "langgraph-v1-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.langgraphDependencyName,
    ),
  })),
);

for (const scenario of scenarios) {
  test(
    `langgraph auto-instrumentation captures spans via the braintrust hook (${scenario.version})`,
    {
      timeout: TIMEOUT_MS,
    },
    async () => {
      await withScenarioHarness(
        async ({ events, payloads, runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              LANGCHAIN_CORE_PACKAGE_NAME: scenario.coreDependencyName,
              LANGCHAIN_OPENAI_PACKAGE_NAME: scenario.openAIDependencyName,
              LANGGRAPH_PACKAGE_NAME: scenario.langgraphDependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.variantKey,
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
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.variantKey}.span-tree.json`,
            ),
          );
          await expect(
            formatJsonFileSnapshot(summaries.payloadSummary),
          ).toMatchFileSnapshot(
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.variantKey}.log-payloads.json`,
            ),
          );
        },
      );
    },
  );
}
