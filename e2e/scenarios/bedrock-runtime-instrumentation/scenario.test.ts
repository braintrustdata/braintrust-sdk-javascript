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
const bedrockRuntimeSdkVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@aws-sdk/client-bedrock-runtime",
);

describe(`bedrock runtime sdk ${bedrockRuntimeSdkVersion}`, () => {
  defineBedrockRuntimeInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          variantKey: "bedrock-runtime-v3-1048-wrapped",
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "bedrock-runtime-v3-1048-wrapped",
    testFileUrl: import.meta.url,
    timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
  });

  defineBedrockRuntimeInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: "bedrock-runtime-v3-1048-auto",
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "bedrock-runtime-v3-1048-auto",
    testFileUrl: import.meta.url,
    timeoutMs: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
  });
});
