import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGenkitInstrumentationAssertions } from "./assertions";
import { GENKIT_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const genkitScenarios = await Promise.all(
  [
    {
      genkitDependencyName: "genkit-v1",
      googleGenAIDependencyName: "genkit-google-genai-v1",
      snapshotName: "genkit-v1",
    },
    {
      genkitDependencyName: "genkit-v1-latest",
      googleGenAIDependencyName: "genkit-google-genai-v1-latest",
      snapshotName: "genkit-v1-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.genkitDependencyName,
    ),
  })),
);

describe.concurrent("variants", () => {
  for (const scenario of genkitScenarios) {
    describe.sequential(`genkit ${scenario.version}`, () => {
      defineGenkitInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: {
              GENKIT_GOOGLE_GENAI_PACKAGE_NAME:
                scenario.googleGenAIDependencyName,
              GENKIT_PACKAGE_NAME: scenario.genkitDependencyName,
            },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        supportsActionSpans: true,
        testFileUrl: import.meta.url,
        timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
      });

      defineGenkitInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              GENKIT_GOOGLE_GENAI_PACKAGE_NAME:
                scenario.googleGenAIDependencyName,
              GENKIT_PACKAGE_NAME: scenario.genkitDependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto`,
        supportsActionSpans: true,
        testFileUrl: import.meta.url,
        timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
