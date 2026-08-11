import { describe, expect, test } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineStagehandInstrumentationAssertions } from "./assertions";
import { stabilizeStagehandActMessages } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;
const scenarios = await Promise.all(
  [
    { dependencyName: "stagehand-v3", snapshotPrefix: "stagehand-v3" },
    {
      dependencyName: "stagehand-v3-latest",
      snapshotPrefix: "stagehand-v3-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

test("stabilizes Chromium accessibility IDs for cassette replay", () => {
  const result = stabilizeStagehandActMessages([
    {
      content: `instruction: Add the Trail Backpack to the cart
Accessibility Tree:
[7-20] RootWebArea: Trail Supply
  [7-42] button: Add to cart`,
      role: "user",
    },
  ]);

  expect(result.liveElementId).toBe("7-42");
  expect(result.messages).toEqual([
    {
      content: expect.stringContaining("[0-14] button: Add to cart"),
      role: "user",
    },
  ]);
  expect(result.messages[0]?.content).not.toContain("[7-42]");
});

describe.sequential("variants", () => {
  for (const scenario of scenarios) {
    describe.sequential(`Stagehand ${scenario.version}`, () => {
      defineStagehandInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: { STAGEHAND_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              cassette: {
                variantKey: `${scenario.snapshotPrefix}-wrapped`,
              },
              originalScenarioDir,
              variantKey: scenario.snapshotPrefix,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotPrefix}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineStagehandInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: { STAGEHAND_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              cassette: {
                variantKey: `${scenario.snapshotPrefix}-auto-hook`,
              },
              originalScenarioDir,
              variantKey: scenario.snapshotPrefix,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotPrefix}-auto-hook`,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
