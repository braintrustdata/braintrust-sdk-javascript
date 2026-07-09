import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGoogleADKInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 90_000;
const googleADKScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.google-adk-v061.mjs",
      dependencyName: "google-adk-sdk-v0",
      snapshotName: "google-adk-v0",
      wrapperEntry: "scenario.google-adk-v061.ts",
    },
    {
      autoEntry: "scenario.google-adk-v061.mjs",
      dependencyName: "google-adk-sdk-v0-latest",
      snapshotName: "google-adk-v0-latest",
      wrapperEntry: "scenario.google-adk-v061.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "google-adk-sdk-v1",
      snapshotName: "google-adk-v1",
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "google-adk-sdk-v1-latest",
      snapshotName: "google-adk-v1-latest",
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
  for (const scenario of googleADKScenarios) {
    describe.sequential(`google adk sdk ${scenario.version}`, () => {
      defineGoogleADKInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { GOOGLE_ADK_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        expectLLMSpan: false,
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineGoogleADKInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { GOOGLE_ADK_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        expectLLMSpan: true,
        snapshotName: `${scenario.snapshotName}-auto-hook`,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
