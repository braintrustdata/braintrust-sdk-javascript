import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCohereInstrumentationAssertions } from "./assertions";
import {
  COHERE_SCENARIO_SPECS,
  COHERE_SCENARIO_TIMEOUT_MS,
} from "./scenario.impl.mjs";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
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

  describe(`cohere sdk ${scenario.version}`, () => {
    defineCohereInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          env: {
            COHERE_PACKAGE_NAME: scenario.dependencyName,
            COHERE_SUPPORTS_THINKING: supportsThinking ? "1" : "0",
          },
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
        });
      },
      requireChatStreamOutput: scenario.snapshotName !== "cohere-v7-14-0",
      snapshotName:
        scenario.snapshotName === "cohere-v7-14-0"
          ? "cohere-v7-14-0-wrapped"
          : scenario.snapshotName,
      supportsThinking,
      testFileUrl: import.meta.url,
      timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
      useV2Namespace: scenario.useV2Namespace ?? false,
    });

    defineCohereInstrumentationAssertions({
      name: "auto-hook instrumentation",
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          env: {
            COHERE_PACKAGE_NAME: scenario.dependencyName,
            COHERE_SUPPORTS_THINKING: supportsThinking ? "1" : "0",
          },
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsThinking,
      testFileUrl: import.meta.url,
      timeoutMs: COHERE_SCENARIO_TIMEOUT_MS,
      useV2Namespace: scenario.useV2Namespace ?? false,
    });
  });
}
