import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAIAgentsAutoInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
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
        runContext: { variantKey: OPENAI_AGENTS_VARIANT_KEY },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    timeoutMs: TIMEOUT_MS,
  });
});
