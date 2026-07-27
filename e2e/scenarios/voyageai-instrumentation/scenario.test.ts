import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineVoyageAIInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

const scenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.cjs-client.mjs",
      dependencyName: "voyageai-sdk-v0",
      snapshotName: "voyageai-v0",
      wrapperEntry: "scenario.cjs-client.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "voyageai-sdk-v0-latest",
      snapshotName: "voyageai-v0-latest",
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

describe.concurrent("variants", () => {
  for (const scenario of scenarios) {
    describe.sequential(`voyageai sdk ${scenario.version}`, () => {
      const env = {
        VOYAGEAI_PACKAGE_NAME: scenario.dependencyName,
      };
      const runContext = {
        originalScenarioDir,
        variantKey: scenario.snapshotName,
      };

      defineVoyageAIInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env,
            runContext,
            scenarioDir,
          });
        },
        snapshotName: scenario.snapshotName,
        testFileUrl: import.meta.url,
      });

      defineVoyageAIInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext,
            scenarioDir,
          });
        },
        snapshotName: scenario.snapshotName,
        testFileUrl: import.meta.url,
      });
    });
  }
});
