import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineAnthropicBedrockInstrumentationAssertions } from "./assertions";
import { ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const bedrockSdkVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@anthropic-ai/bedrock-sdk",
);

describe(`anthropic bedrock sdk ${bedrockSdkVersion}`, () => {
  defineAnthropicBedrockInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          variantKey: "anthropic-bedrock-v0302-wrapped",
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "anthropic-bedrock-v0302-wrapped",
    testFileUrl: import.meta.url,
    timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
  });

  defineAnthropicBedrockInstrumentationAssertions({
    name: "auto-hook instrumentation ESM",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: "anthropic-bedrock-v0302-auto-esm",
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "anthropic-bedrock-v0302-auto-esm",
    testFileUrl: import.meta.url,
    timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
  });

  defineAnthropicBedrockInstrumentationAssertions({
    name: "auto-hook instrumentation CJS",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.cjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: "anthropic-bedrock-v0302-auto-cjs",
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "anthropic-bedrock-v0302-auto-cjs",
    testFileUrl: import.meta.url,
    timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
  });
});
