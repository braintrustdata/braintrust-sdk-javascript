import { describe } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGoogleADKInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;
const snapshotName = "google-adk-v061";

describe("google adk sdk 0.6.1", () => {
  defineGoogleADKInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: { variantKey: snapshotName },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    expectLLMSpan: false,
    snapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  defineGoogleADKInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        env: {
          BRAINTRUST_DISABLE_INSTRUMENTATION: "google-adk",
        },
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: snapshotName },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    expectLLMSpan: true,
    snapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
