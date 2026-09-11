import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGoogleGenerativeAIInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;
const scenarios = await Promise.all(
  ["v0", "v0-latest"].map(async (variant) => {
    const dependencyName = `google-generative-ai-sdk-${variant}`;
    return {
      dependencyName,
      snapshotName: `google-generative-ai-${variant}`,
      version: await readInstalledPackageVersion(scenarioDir, dependencyName),
    };
  }),
);

describe.concurrent("variants", () => {
  for (const scenario of scenarios) {
    describe.sequential(`google generative ai sdk ${scenario.version}`, () => {
      defineGoogleGenerativeAIInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: { GOOGLE_GENERATIVE_AI_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              originalScenarioDir,
              variantKey: scenario.snapshotName,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineGoogleGenerativeAIInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            env: { GOOGLE_GENERATIVE_AI_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              originalScenarioDir,
              variantKey: scenario.snapshotName,
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
