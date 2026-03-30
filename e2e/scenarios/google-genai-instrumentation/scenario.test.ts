import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGoogleGenAIInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;
const googleGenAIScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.google-genai-v1300.mjs",
      dependencyName: "google-genai-sdk-v1300",
      snapshotName: "google-genai-v1300",
      wrapperEntry: "scenario.google-genai-v1300.ts",
    },
    {
      autoEntry: "scenario.google-genai-v1440.mjs",
      dependencyName: "google-genai-sdk-v1440",
      snapshotName: "google-genai-v1440",
      wrapperEntry: "scenario.google-genai-v1440.ts",
    },
    {
      autoEntry: "scenario.google-genai-v1450.mjs",
      dependencyName: "google-genai-sdk-v1450",
      snapshotName: "google-genai-v1450",
      wrapperEntry: "scenario.google-genai-v1450.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "@google/genai",
      snapshotName: "google-genai-v1460",
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

for (const scenario of googleGenAIScenarios) {
  describe(`google genai sdk ${scenario.version}`, () => {
    defineGoogleGenAIInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
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
          nodeArgs: ["--import", "braintrust/hook.mjs"],
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
