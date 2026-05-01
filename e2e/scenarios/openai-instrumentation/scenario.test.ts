import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { cassetteTagsFor } from "../../helpers/tags";
import { defineOpenAIInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;
const openaiScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.openai-v4.mjs",
      disablePrivateFieldMethodsAssertion: true,
      dependencyName: "openai-v4",
      snapshotName: "openai-v4",
      wrapperEntry: "scenario.openai-v4.ts",
    },
    {
      autoEntry: "scenario.openai-v5.mjs",
      disablePrivateFieldMethodsAssertion: true,
      dependencyName: "openai-v5",
      snapshotName: "openai-v5",
      wrapperEntry: "scenario.openai-v5.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openai",
      snapshotName: "openai-v6",
      wrapperEntry: "scenario.ts",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

for (const scenario of openaiScenarios) {
  const assertPrivateFieldMethodsOperation =
    !scenario.disablePrivateFieldMethodsAssertion;
  const tags = cassetteTagsFor(import.meta.url, scenario.snapshotName);

  describe(`openai sdk ${scenario.version}`, { tags }, () => {
    defineOpenAIInstrumentationAssertions({
      assertPrivateFieldMethodsOperation,
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          runContext: {
            variantKey: scenario.snapshotName,
            originalScenarioDir,
          },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
      version: scenario.version,
    });

    defineOpenAIInstrumentationAssertions({
      name: "auto-hook instrumentation",
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: {
            variantKey: scenario.snapshotName,
            originalScenarioDir,
          },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
      version: scenario.version,
    });
  });
}
