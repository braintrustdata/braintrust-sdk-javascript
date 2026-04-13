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
describe("google adk sdk 0.6.1", () => {
  defineGoogleADKInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: { variantKey: "google-adk-v061-wrapped" },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    expectLLMSpan: false,
    snapshotName: "google-adk-v061-wrapped",
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  defineGoogleADKInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: "google-adk-v061-auto" },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    expectLLMSpan: true,
    snapshotName: "google-adk-v061-auto",
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
