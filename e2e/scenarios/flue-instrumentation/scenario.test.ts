import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineFlueInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const flueVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@flue/runtime",
);
const TIMEOUT_MS = 120_000;
const wrappedVariantKey = "flue-v0-7-0-wrapped";
const autoHookVariantKey = "flue-v0-7-0-auto-hook";

describe(`flue ${flueVersion}`, () => {
  defineFlueInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          originalScenarioDir,
          variantKey: wrappedVariantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: "flue-v0-7-0-wrapped",
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  defineFlueInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          originalScenarioDir,
          variantKey: autoHookVariantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: "flue-v0-7-0-auto-hook",
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
