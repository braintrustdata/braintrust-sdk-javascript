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

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
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

describe.concurrent("variants", () => {
  for (const scenario of mistralScenarios) {
    describe.sequential(`mistral sdk ${scenario.version}`, () => {
      defineMistralInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { MISTRAL_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        ...(scenario.supportsThinkingStream === false
          ? { supportsThinkingStream: false }
          : {}),
        ...(scenario.supportsClassifiers === false
          ? { supportsClassifiers: false }
          : {}),
        ...(scenario.supportsClassify === false
          ? { supportsClassify: false }
          : {}),
        testFileUrl: import.meta.url,
        timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
      });

      defineMistralInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { MISTRAL_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        ...(scenario.supportsThinkingStream === false
          ? { supportsThinkingStream: false }
          : {}),
        ...(scenario.supportsClassifiers === false
          ? { supportsClassifiers: false }
          : {}),
        ...(scenario.supportsClassify === false
          ? { supportsClassify: false }
          : {}),
        testFileUrl: import.meta.url,
        timeoutMs: MISTRAL_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
