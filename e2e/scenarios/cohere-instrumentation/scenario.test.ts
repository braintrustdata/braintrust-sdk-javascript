import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { cassetteTagsFor } from "../../helpers/tags";
import { defineCohereInstrumentationAssertions } from "./assertions";
import {
  COHERE_SCENARIO_SPECS,
  COHERE_SCENARIO_TIMEOUT_MS,
} from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

const cohereScenarios = await Promise.all(
  COHERE_SCENARIO_SPECS.map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

for (const scenario of cohereScenarios) {
  const supportsThinking = scenario.supportsThinking ?? true;
  const tags = cassetteTagsFor(import.meta.url, scenario.snapshotName);

  describe(`cohere sdk ${scenario.version}`, { tags }, () => {
    defineCohereInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          env: {
            COHERE_SUPPORTS_THINKING: supportsThinking ? "1" : "0",
          },
          runContext: {
            variantKey: scenario.snapshotName,
            originalScenarioDir,
          },
          scenarioDir,
          timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsThinking,
      testFileUrl: import.meta.url,
      timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
    });

    defineCohereInstrumentationAssertions({
      name: "auto-hook instrumentation",
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          env: {
            COHERE_SUPPORTS_THINKING: supportsThinking ? "1" : "0",
          },
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: {
            variantKey: scenario.snapshotName,
            originalScenarioDir,
          },
          scenarioDir,
          timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsThinking,
      testFileUrl: import.meta.url,
      timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
    });
  });
}
