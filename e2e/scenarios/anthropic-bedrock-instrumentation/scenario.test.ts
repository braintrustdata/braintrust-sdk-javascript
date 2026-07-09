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
const anthropicBedrockScenarios = await Promise.all(
  [
    {
      dependencyName: "anthropic-bedrock-sdk-v0",
      snapshotName: "anthropic-bedrock-v0",
    },
    {
      dependencyName: "anthropic-bedrock-sdk-v0-latest",
      snapshotName: "anthropic-bedrock-v0-latest",
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
  for (const scenario of anthropicBedrockScenarios) {
    describe.sequential(`anthropic bedrock sdk ${scenario.version}`, () => {
      defineAnthropicBedrockInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: {
              ANTHROPIC_BEDROCK_PACKAGE_NAME: scenario.dependencyName,
            },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
      });

      defineAnthropicBedrockInstrumentationAssertions({
        name: "auto-hook instrumentation ESM",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              ANTHROPIC_BEDROCK_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-esm`,
        testFileUrl: import.meta.url,
        timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
      });

      defineAnthropicBedrockInstrumentationAssertions({
        name: "auto-hook instrumentation CJS",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.cjs",
            env: {
              ANTHROPIC_BEDROCK_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-cjs`,
        testFileUrl: import.meta.url,
        timeoutMs: ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
