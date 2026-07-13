import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineLangSmithInstrumentationAssertions } from "./assertions";
import {
  LANGSMITH_SCENARIO_SPECS,
  LANGSMITH_SCENARIO_TIMEOUT_MS,
} from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const scenarios = await Promise.all(
  LANGSMITH_SCENARIO_SPECS.map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);
const baseEnv = {
  BRAINTRUST_DISABLE_INSTRUMENTATION: "openai",
  LANGCHAIN_TRACING_V2: "true",
  LANGSMITH_API_KEY: "ls-test-key",
  LANGSMITH_ENDPOINT: "http://langsmith.invalid",
  LANGSMITH_TRACING: "true",
};

describe.concurrent("variants", () => {
  for (const scenario of scenarios) {
    describe.sequential(`langsmith sdk ${scenario.version}`, () => {
      defineLangSmithInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.wrapper.ts",
            env: {
              ...baseEnv,
              LANGSMITH_PACKAGE_NAME: scenario.dependencyName,
            },
            runContext: {
              originalScenarioDir,
              variantKey: scenario.snapshotName,
            },
            scenarioDir,
            timeoutMs: LANGSMITH_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: LANGSMITH_SCENARIO_TIMEOUT_MS,
      });

      defineLangSmithInstrumentationAssertions({
        includeLangChain: scenario.dependencyName === "langsmith-v081",
        name: "auto-hook instrumentation ESM",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.auto.mjs",
            env: {
              ...baseEnv,
              LANGSMITH_INCLUDE_LANGCHAIN:
                scenario.dependencyName === "langsmith-v081" ? "1" : "0",
              LANGSMITH_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              originalScenarioDir,
              variantKey: scenario.snapshotName,
            },
            scenarioDir,
            timeoutMs: LANGSMITH_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-esm`,
        testFileUrl: import.meta.url,
        timeoutMs: LANGSMITH_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});

defineLangSmithInstrumentationAssertions({
  name: "latest auto-hook instrumentation CJS",
  runScenario: async ({ runNodeScenarioDir }) => {
    await runNodeScenarioDir({
      entry: "scenario.auto.cjs",
      env: baseEnv,
      nodeArgs: ["--import", "braintrust/hook.mjs"],
      runContext: {
        originalScenarioDir,
        variantKey: "langsmith-v0-8-1",
      },
      scenarioDir,
      timeoutMs: LANGSMITH_SCENARIO_TIMEOUT_MS,
    });
  },
  snapshotName: "langsmith-v0-8-1-auto-cjs",
  testFileUrl: import.meta.url,
  timeoutMs: LANGSMITH_SCENARIO_TIMEOUT_MS,
});
