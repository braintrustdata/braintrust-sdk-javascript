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
const strandsAgentSDKScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.mjs",
      autoSnapshotName: "strands-agent-sdk-v1-auto-hook",
      dependencyName: "strands-agent-sdk-v1",
      expectOverlapParentProbe: true,
      variantKey: "strands-agent-sdk-v1",
      wrapperEntry: "scenario.ts",
      wrapperSnapshotName: "strands-agent-sdk-v1-wrapped",
    },
    {
      autoEntry: "scenario.mjs",
      autoSnapshotName: "strands-agent-sdk-v1-latest-auto-hook",
      dependencyName: "strands-agent-sdk-v1-latest",
      expectOverlapParentProbe: false,
      variantKey: "strands-agent-sdk-v1-latest",
      wrapperEntry: "scenario.ts",
      wrapperSnapshotName: "strands-agent-sdk-v1-latest-wrapped",
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
  for (const scenario of strandsAgentSDKScenarios) {
    describe.sequential(`Strands Agent SDK ${scenario.version}`, () => {
      defineStrandsAgentSDKInstrumentationAssertions({
        expectOverlapParentProbe: scenario.expectOverlapParentProbe,
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { STRANDS_AGENT_SDK_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.wrapperSnapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineStrandsAgentSDKInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { STRANDS_AGENT_SDK_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.autoSnapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
