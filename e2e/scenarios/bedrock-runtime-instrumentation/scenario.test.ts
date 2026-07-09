import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineBedrockRuntimeInstrumentationAssertions } from "./assertions";
import { BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const bedrockRuntimeScenarios = await Promise.all(
  [
    {
      dependencyName: "bedrock-runtime-sdk-v3",
      snapshotName: "bedrock-runtime-v3",
    },
    {
      dependencyName: "bedrock-runtime-sdk-v3-latest",
      snapshotName: "bedrock-runtime-v3-latest",
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
  for (const scenario of bedrockRuntimeScenarios) {
    describe.sequential(`bedrock runtime sdk ${scenario.version}`, () => {
      defineBedrockRuntimeInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: { BEDROCK_RUNTIME_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
      });

      defineBedrockRuntimeInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: { BEDROCK_RUNTIME_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto`,
        testFileUrl: import.meta.url,
        timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
