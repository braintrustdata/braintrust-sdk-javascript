import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineMistralInstrumentationAssertions } from "./assertions";
import {
  MISTRAL_SCENARIO_SPECS,
  MISTRAL_SCENARIO_TIMEOUT_MS,
} from "./scenario.impl.mjs";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

const mistralScenarios = await Promise.all(
  MISTRAL_SCENARIO_SPECS.map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

for (const scenario of mistralScenarios) {
  describe(`mistral sdk ${scenario.version}`, () => {
    defineMistralInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      ...(scenario.supportsThinkingStream === false
        ? { supportsThinkingStream: false }
        : {}),
      testFileUrl: import.meta.url,
      timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
    });

    defineMistralInstrumentationAssertions({
      name: "auto-hook instrumentation",
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      ...(scenario.supportsThinkingStream === false
        ? { supportsThinkingStream: false }
        : {}),
      testFileUrl: import.meta.url,
      timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
    });
  });
}
