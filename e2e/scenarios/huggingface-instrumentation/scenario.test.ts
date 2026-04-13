import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineHuggingFaceInstrumentationAssertions } from "./assertions";
import {
  HUGGINGFACE_SCENARIO_SPECS,
  HUGGINGFACE_SCENARIO_TIMEOUT_MS,
} from "./scenario.impl.mjs";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

const huggingFaceScenarios = await Promise.all(
  HUGGINGFACE_SCENARIO_SPECS.map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

for (const scenario of huggingFaceScenarios) {
  describe(`huggingface inference sdk ${scenario.version}`, () => {
    defineHuggingFaceInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: HUGGINGFACE_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      testFileUrl: import.meta.url,
      timeoutMs: HUGGINGFACE_SCENARIO_TIMEOUT_MS,
    });

    defineHuggingFaceInstrumentationAssertions({
      name: "auto-hook instrumentation",
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: HUGGINGFACE_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      testFileUrl: import.meta.url,
      timeoutMs: HUGGINGFACE_SCENARIO_TIMEOUT_MS,
    });
  });
}
