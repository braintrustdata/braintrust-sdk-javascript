import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAIInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 60_000;
const openaiScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.openai-v4.mjs",
      dependencyName: "openai-v4",
      snapshotName: "openai-v4",
      wrapperEntry: "scenario.openai-v4.ts",
    },
    {
      autoEntry: "scenario.openai-v5.mjs",
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
  describe(`openai sdk ${scenario.version}`, () => {
    defineOpenAIInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
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
