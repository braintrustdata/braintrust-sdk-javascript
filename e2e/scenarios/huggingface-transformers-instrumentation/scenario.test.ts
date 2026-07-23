import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineAssertions } from "./assertions";
import { SCENARIO_SPECS, SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const scenarios = await Promise.all(
  SCENARIO_SPECS.map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.concurrent("variants", () => {
  for (const scenario of scenarios) {
    describe.sequential(`Transformers.js ${scenario.version}`, () => {
      defineAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.wrapper.ts",
            env: {
              HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME: scenario.dependencyName,
            },
            runContext: {
              cassette: false,
              originalScenarioDir,
              variantKey: scenario.snapshotName,
            },
            scenarioDir,
            timeoutMs: SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: SCENARIO_TIMEOUT_MS,
      });

      defineAssertions({
        name: "auto-hook instrumentation ESM",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.auto.mjs",
            env: {
              HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              cassette: false,
              originalScenarioDir,
              variantKey: scenario.snapshotName,
            },
            scenarioDir,
            timeoutMs: SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-esm`,
        testFileUrl: import.meta.url,
        timeoutMs: SCENARIO_TIMEOUT_MS,
      });
    });
  }
});

const latestV4 = scenarios.at(-1);
if (!latestV4) {
  throw new Error("Expected a latest Transformers.js v4 scenario");
}

defineAssertions({
  name: `Transformers.js ${latestV4.version} auto-hook instrumentation CJS`,
  runScenario: async ({ runNodeScenarioDir }) => {
    await runNodeScenarioDir({
      entry: "scenario.auto.cjs",
      env: {
        HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME: latestV4.dependencyName,
      },
      nodeArgs: ["--import", "braintrust/hook.mjs"],
      runContext: {
        cassette: false,
        originalScenarioDir,
        variantKey: latestV4.snapshotName,
      },
      scenarioDir,
      timeoutMs: SCENARIO_TIMEOUT_MS,
    });
  },
  snapshotName: `${latestV4.snapshotName}-auto-cjs`,
  testFileUrl: import.meta.url,
  timeoutMs: SCENARIO_TIMEOUT_MS,
});
