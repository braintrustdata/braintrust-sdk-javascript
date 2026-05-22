import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineFlueInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const flueVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@flue/runtime",
);
const TIMEOUT_MS = 120_000;
const wrappedVariantKey = "flue-v0-7-0-wrapped";
const autoHookVariantKey = "flue-v0-7-0-auto-hook";
const openAIAutoHookVariantKey = "flue-v0-7-0-openai-auto-hook";

const openAIPromptEnv = {
  FLUE_E2E_PROMPT_MODEL: "openai/gpt-4o-mini",
  FLUE_E2E_PROMPT_THINKING_LEVEL: "off",
};

describe(`flue ${flueVersion}`, () => {
  defineFlueInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          originalScenarioDir,
          variantKey: wrappedVariantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: "flue-v0-7-0-wrapped",
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  defineFlueInstrumentationAssertions({
    expectedPromptProviderSpanName: "anthropic.messages.create",
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          originalScenarioDir,
          variantKey: autoHookVariantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: "flue-v0-7-0-auto-hook",
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  defineFlueInstrumentationAssertions({
    expectedPromptProviderSpanName: "openai.responses.create",
    expectThinking: false,
    name: "auto-hook instrumentation with OpenAI prompt model",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        env: openAIPromptEnv,
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          originalScenarioDir,
          variantKey: openAIAutoHookVariantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: "flue-v0-7-0-openai-auto-hook",
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
