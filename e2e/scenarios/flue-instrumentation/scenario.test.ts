import { describe, test } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
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
const variantKey = "flue-v0-8-0";

describe.sequential(`flue ${flueVersion}`, () => {
  defineFlueInstrumentationAssertions({
    name: "explicit instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          originalScenarioDir,
          variantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: `${variantKey}-explicit`,
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
          variantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: `${variantKey}-auto-hook`,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  test("runs through flue cli", { timeout: TIMEOUT_MS }, async () => {
    await withScenarioHarness(async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.cli.mjs",
        runContext: {
          originalScenarioDir,
          variantKey,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    });
  });
});
