import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineClaudeAgentSDKInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 120_000;
const claudeAgentSDKScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.claude-agent-sdk-v0.1.mjs",
      dependencyName: "claude-agent-sdk-v0.1",
      snapshotName: "claude-agent-sdk-v0.1",
      wrapperEntry: "scenario.claude-agent-sdk-v0.1.ts",
    },
    {
      autoEntry: "scenario.claude-agent-sdk-v0.2.76.mjs",
      dependencyName: "claude-agent-sdk-v0.2.76",
      snapshotName: "claude-agent-sdk-v0.2.76",
      wrapperEntry: "scenario.claude-agent-sdk-v0.2.76.ts",
    },
    {
      autoEntry: "scenario.claude-agent-sdk-v0.2.79.mjs",
      dependencyName: "claude-agent-sdk-v0.2.79",
      snapshotName: "claude-agent-sdk-v0.2.79",
      wrapperEntry: "scenario.claude-agent-sdk-v0.2.79.ts",
    },
    {
      autoEntry: "scenario.claude-agent-sdk-v0.2.81.mjs",
      dependencyName: "claude-agent-sdk-v0.2.81",
      snapshotName: "claude-agent-sdk-v0.2.81",
      wrapperEntry: "scenario.claude-agent-sdk-v0.2.81.ts",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe("wrapped instrumentation", () => {
  for (const scenario of claudeAgentSDKScenarios) {
    defineClaudeAgentSDKInstrumentationAssertions({
      name: `claude agent sdk ${scenario.version}`,
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });
  }
});

describe("auto-hook instrumentation", () => {
  for (const scenario of claudeAgentSDKScenarios) {
    defineClaudeAgentSDKInstrumentationAssertions({
      name: `claude agent sdk ${scenario.version}`,
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });
  }
});
