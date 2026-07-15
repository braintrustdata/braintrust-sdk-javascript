import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCursorSDKInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 240_000;
const cursorSDKScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.cursor-sdk-v1.mjs",
      autoSnapshotName: "cursor-sdk-v1-auto-hook",
      dependencyName: "cursor-sdk-v1",
      variantKey: "cursor-sdk-v1",
      wrapperEntry: "scenario.cursor-sdk-v1.ts",
      wrapperSnapshotName: "cursor-sdk-v1-wrapped",
    },
    {
      autoEntry: "scenario.cursor-sdk-v1.mjs",
      autoSnapshotName: "cursor-sdk-v1-latest-auto-hook",
      dependencyName: "cursor-sdk-v1-latest",
      variantKey: "cursor-sdk-v1-latest",
      wrapperEntry: "scenario.cursor-sdk-v1.ts",
      wrapperSnapshotName: "cursor-sdk-v1-latest-wrapped",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.concurrent("variants", () => {
  for (const cursorSDKScenario of cursorSDKScenarios) {
    describe.sequential(`cursor sdk ${cursorSDKScenario.version}`, () => {
      defineCursorSDKInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: cursorSDKScenario.wrapperEntry,
            env: { CURSOR_SDK_PACKAGE_NAME: cursorSDKScenario.dependencyName },
            runContext: {
              variantKey: cursorSDKScenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: cursorSDKScenario.wrapperSnapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineCursorSDKInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: cursorSDKScenario.autoEntry,
            env: { CURSOR_SDK_PACKAGE_NAME: cursorSDKScenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: cursorSDKScenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: cursorSDKScenario.autoSnapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
