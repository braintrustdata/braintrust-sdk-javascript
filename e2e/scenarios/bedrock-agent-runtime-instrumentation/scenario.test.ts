import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineBedrockAgentRuntimeInstrumentationAssertions } from "./assertions";
import { BEDROCK_AGENT_RUNTIME_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const scenarios = await Promise.all(
  [
    {
      dependencyName: "bedrock-agent-runtime-sdk-v3",
      snapshotName: "bedrock-agent-runtime-v3",
    },
    {
      dependencyName: "bedrock-agent-runtime-sdk-v3-latest",
      snapshotName: "bedrock-agent-runtime-v3-latest",
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
  for (const scenario of scenarios) {
    describe.sequential(`bedrock agent runtime sdk ${scenario.version}`, () => {
      defineBedrockAgentRuntimeInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: {
              BEDROCK_AGENT_RUNTIME_PACKAGE_NAME: scenario.dependencyName,
            },
            runContext: {
              cassette: false,
              variantKey: scenario.snapshotName,
            },
            scenarioDir,
            timeoutMs: BEDROCK_AGENT_RUNTIME_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: BEDROCK_AGENT_RUNTIME_SCENARIO_TIMEOUT_MS,
      });

      defineBedrockAgentRuntimeInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              BEDROCK_AGENT_RUNTIME_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              cassette: false,
              variantKey: scenario.snapshotName,
            },
            scenarioDir,
            timeoutMs: BEDROCK_AGENT_RUNTIME_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto`,
        testFileUrl: import.meta.url,
        timeoutMs: BEDROCK_AGENT_RUNTIME_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
