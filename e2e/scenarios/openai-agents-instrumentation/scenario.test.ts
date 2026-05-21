import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAIAgentsAutoInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const OPENAI_AGENTS_VARIANT_KEY = "openai-agents-auto-hook";
const openAIAgentsVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@openai/agents",
);
const TIMEOUT_MS = 60_000;

describe(`openai agents sdk ${openAIAgentsVersion}`, () => {
  defineOpenAIAgentsAutoInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        env: {
          NODE_ENV: "development",
        },
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: OPENAI_AGENTS_VARIANT_KEY,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: OPENAI_AGENTS_VARIANT_KEY,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
