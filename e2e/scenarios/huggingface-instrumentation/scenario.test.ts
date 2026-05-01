import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { cassetteTagsFor } from "../../helpers/tags";
import { defineHuggingFaceInstrumentationAssertions } from "./assertions";
import {
  HUGGINGFACE_SCENARIO_SPECS,
  HUGGINGFACE_SCENARIO_TIMEOUT_MS,
} from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
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
  const tags = cassetteTagsFor(import.meta.url, scenario.snapshotName);

  describe(`huggingface inference sdk ${scenario.version}`, { tags }, () => {
    defineHuggingFaceInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          runContext: {
            variantKey: scenario.snapshotName,
            originalScenarioDir,
          },
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
          runContext: {
            variantKey: scenario.snapshotName,
            originalScenarioDir,
          },
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
