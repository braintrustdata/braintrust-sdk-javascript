import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { cassetteTagsFor } from "../../helpers/tags";
import { defineOpenRouterAgentTraceAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const openrouterAgentVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@openrouter/agent",
);
const OPENROUTER_AGENT_VARIANT_KEY = "openrouter-agent-current";
const TIMEOUT_MS = 90_000;

const tags = cassetteTagsFor(import.meta.url, OPENROUTER_AGENT_VARIANT_KEY);

describe(`openrouter agent ${openrouterAgentVersion}`, { tags }, () => {
  defineOpenRouterAgentTraceAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          variantKey: OPENROUTER_AGENT_VARIANT_KEY,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    timeoutMs: TIMEOUT_MS,
  });

  defineOpenRouterAgentTraceAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: OPENROUTER_AGENT_VARIANT_KEY,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    timeoutMs: TIMEOUT_MS,
  });
});
