import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGoogleGenAIInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 90_000;
const googleGenAIScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.google-genai-v1300.mjs",
      dependencyName: "google-genai-sdk-v1",
      snapshotName: "google-genai-v1",
      wrapperEntry: "scenario.google-genai-v1300.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "google-genai-sdk-v1-latest",
      snapshotName: "google-genai-v1-latest",
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.google-genai-v280.mjs",
      dependencyName: "google-genai-sdk-v2",
      snapshotName: "google-genai-v2",
      wrapperEntry: "scenario.google-genai-v280.ts",
    },
    {
      autoEntry: "scenario.google-genai-v280.mjs",
      dependencyName: "google-genai-sdk-v2-latest",
      snapshotName: "google-genai-v2-latest",
      wrapperEntry: "scenario.google-genai-v280.ts",
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
  for (const scenario of googleGenAIScenarios) {
    describe.sequential(`google genai sdk ${scenario.version}`, () => {
      defineGoogleGenAIInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { GOOGLE_GENAI_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineGoogleGenAIInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { GOOGLE_GENAI_PACKAGE_NAME: scenario.dependencyName },
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
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
