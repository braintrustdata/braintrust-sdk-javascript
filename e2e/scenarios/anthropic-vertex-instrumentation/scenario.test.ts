import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineAnthropicVertexInstrumentationAssertions } from "./assertions";
const ANTHROPIC_VERTEX_SCENARIO_TIMEOUT_MS = 180_000;

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const anthropicVertexScenarios = await Promise.all(
  [
    {
      dependencyName: "anthropic-vertex-sdk-v0",
      snapshotName: "anthropic-vertex-v0",
    },
    {
      dependencyName: "anthropic-vertex-sdk-v0-latest",
      snapshotName: "anthropic-vertex-v0-latest",
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
  for (const scenario of anthropicVertexScenarios) {
    describe.sequential(`anthropic vertex sdk ${scenario.version}`, () => {
      defineAnthropicVertexInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: {
              ANTHROPIC_VERTEX_PACKAGE_NAME: scenario.dependencyName,
            },
            runContext: {
              cassette: false,
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: ANTHROPIC_VERTEX_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: ANTHROPIC_VERTEX_SCENARIO_TIMEOUT_MS,
      });

      defineAnthropicVertexInstrumentationAssertions({
        name: "auto-hook instrumentation ESM",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              ANTHROPIC_VERTEX_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              cassette: false,
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: ANTHROPIC_VERTEX_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-esm`,
        testFileUrl: import.meta.url,
        timeoutMs: ANTHROPIC_VERTEX_SCENARIO_TIMEOUT_MS,
      });

      defineAnthropicVertexInstrumentationAssertions({
        name: "auto-hook instrumentation CJS",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.cjs",
            env: {
              ANTHROPIC_VERTEX_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              cassette: false,
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: ANTHROPIC_VERTEX_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-cjs`,
        testFileUrl: import.meta.url,
        timeoutMs: ANTHROPIC_VERTEX_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
