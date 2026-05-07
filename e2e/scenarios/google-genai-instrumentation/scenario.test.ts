import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { cassetteTagsFor } from "../../helpers/tags";
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
  const tags = cassetteTagsFor(import.meta.url, scenario.snapshotName);

  describe(`google genai sdk ${scenario.version}`, { tags }, () => {
    defineGoogleGenAIInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
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
