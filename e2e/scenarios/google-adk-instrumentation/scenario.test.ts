import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGoogleADKInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;
const googleADKScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.google-adk-v061.mjs",
      dependencyName: "google-adk-sdk-v061",
      snapshotName: "google-adk-v061",
      wrapperEntry: "scenario.google-adk-v061.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "@google/adk",
      snapshotName: "google-adk-v1000",
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

for (const scenario of googleADKScenarios) {
  describe(`google adk sdk ${scenario.version}`, () => {
    defineGoogleADKInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          runContext: { variantKey: `${scenario.snapshotName}-wrapped` },
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
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: { variantKey: `${scenario.snapshotName}-auto` },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      expectLLMSpan: true,
      snapshotName: `${scenario.snapshotName}-auto`,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });
  });
}
