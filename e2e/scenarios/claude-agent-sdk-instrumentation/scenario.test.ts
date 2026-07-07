import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineClaudeAgentSDKInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 300_000;
const claudeAgentSDKScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.claude-agent-sdk-v0.2.76.mjs",
      dependencyName: "claude-agent-sdk-v0",
      snapshotName: "claude-agent-sdk-v0",
      wrapperEntry: "scenario.claude-agent-sdk-v0.2.76.ts",
    },
    {
      autoEntry: "scenario.claude-agent-sdk-v0.2.81.mjs",
      dependencyName: "claude-agent-sdk-v0-latest",
      snapshotName: "claude-agent-sdk-v0-latest",
      wrapperEntry: "scenario.claude-agent-sdk-v0.2.81.ts",
    },
  ].map(async (scenario) => {
    const { expectTaskLifecycleDetails = true, ...scenarioWithoutDefaults } =
      scenario;
    return {
      ...scenarioWithoutDefaults,
      expectTaskLifecycleDetails,
      version: await readInstalledPackageVersion(
        scenarioDir,
        scenario.dependencyName,
      ),
    };
  }),
);

describe.concurrent("wrapped instrumentation", () => {
  for (const scenario of claudeAgentSDKScenarios) {
    describe.sequential(`claude agent sdk ${scenario.version}`, () => {
      defineClaudeAgentSDKInstrumentationAssertions({
        assertLocalToolHandlerParenting: true,
        expectTaskLifecycleDetails: scenario.expectTaskLifecycleDetails,
        name: "scenario",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { CLAUDE_AGENT_SDK_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});

describe.concurrent("auto-hook instrumentation", () => {
  for (const scenario of claudeAgentSDKScenarios) {
    describe.sequential(`claude agent sdk ${scenario.version}`, () => {
      defineClaudeAgentSDKInstrumentationAssertions({
        assertLocalToolHandlerParenting: true,
        expectTaskLifecycleDetails: scenario.expectTaskLifecycleDetails,
        name: "scenario",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { CLAUDE_AGENT_SDK_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-hook`,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
