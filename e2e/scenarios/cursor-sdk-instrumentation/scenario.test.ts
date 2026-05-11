import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineCursorSDKInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 240_000;
const cursorSDKScenario = {
  autoEntry: "scenario.cursor-sdk-v1.mjs",
  autoSnapshotName: "cursor-sdk-v1-auto-hook",
  dependencyName: "cursor-sdk-v1",
  version: await readInstalledPackageVersion(scenarioDir, "cursor-sdk-v1"),
  wrapperEntry: "scenario.cursor-sdk-v1.ts",
  wrapperSnapshotName: "cursor-sdk-v1-wrapped",
  variantKey: "cursor-sdk-v1",
};

describe("wrapped instrumentation", () => {
  defineCursorSDKInstrumentationAssertions({
    name: `cursor sdk ${cursorSDKScenario.version}`,
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: cursorSDKScenario.wrapperEntry,
        runContext: { variantKey: cursorSDKScenario.variantKey },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: cursorSDKScenario.wrapperSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});

describe("auto-hook instrumentation", () => {
  defineCursorSDKInstrumentationAssertions({
    name: `cursor sdk ${cursorSDKScenario.version}`,
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: cursorSDKScenario.autoEntry,
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: cursorSDKScenario.variantKey },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: cursorSDKScenario.autoSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
