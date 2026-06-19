import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineStrandsAgentSDKInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 240_000;
const strandsAgentSDKScenario = {
  autoEntry: "scenario.mjs",
  autoSnapshotName: "strands-agent-sdk-v160-auto-hook",
  version: await readInstalledPackageVersion(
    scenarioDir,
    "@strands-agents/sdk",
  ),
  wrapperEntry: "scenario.ts",
  wrapperSnapshotName: "strands-agent-sdk-v160-wrapped",
  variantKey: "strands-agent-sdk-v160",
};

describe("wrapped instrumentation", () => {
  defineStrandsAgentSDKInstrumentationAssertions({
    name: `Strands Agent SDK ${strandsAgentSDKScenario.version}`,
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: strandsAgentSDKScenario.wrapperEntry,
        runContext: {
          variantKey: strandsAgentSDKScenario.variantKey,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: strandsAgentSDKScenario.wrapperSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});

describe("auto-hook instrumentation", () => {
  defineStrandsAgentSDKInstrumentationAssertions({
    name: `Strands Agent SDK ${strandsAgentSDKScenario.version}`,
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: strandsAgentSDKScenario.autoEntry,
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: strandsAgentSDKScenario.variantKey,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: strandsAgentSDKScenario.autoSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
