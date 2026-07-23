import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenRouterTraceAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 300_000;
const openRouterScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.openrouter-v0911.mjs",
      dependencyName: "openrouter-sdk-v0",
      snapshotName: "openrouter-v0",
      supportsRerank: false,
      wrapperEntry: "scenario.openrouter-v0911.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openrouter-sdk-v0-latest",
      snapshotName: "openrouter-v0-latest",
      supportsRerank: true,
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openrouter-sdk-v1",
      snapshotName: "openrouter-v1",
      supportsRerank: true,
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openrouter-sdk-v1-latest",
      snapshotName: "openrouter-v1-latest",
      supportsRerank: true,
      wrapperEntry: "scenario.ts",
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
  for (const scenario of openRouterScenarios) {
    describe.sequential(`openrouter sdk ${scenario.version}`, () => {
      defineOpenRouterTraceAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { OPENROUTER_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        supportsRerank: scenario.supportsRerank,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineOpenRouterTraceAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { OPENROUTER_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        supportsRerank: scenario.supportsRerank,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
