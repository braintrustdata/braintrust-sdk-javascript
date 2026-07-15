import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenRouterAgentTraceAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 90_000;
const openRouterAgentScenarios = await Promise.all(
  [
    {
      dependencyName: "openrouter-agent-v0",
      variantKey: "openrouter-agent-v0",
    },
    {
      dependencyName: "openrouter-agent-v0-latest",
      variantKey: "openrouter-agent-v0-latest",
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
  for (const scenario of openRouterAgentScenarios) {
    describe.sequential(`openrouter agent ${scenario.version}`, () => {
      defineOpenRouterAgentTraceAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: { OPENROUTER_AGENT_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.variantKey,
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
            env: { OPENROUTER_AGENT_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
