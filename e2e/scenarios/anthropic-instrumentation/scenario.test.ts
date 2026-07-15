import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineAnthropicInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 150_000;
const anthropicScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.anthropic-v0273.mjs",
      dependencyName: "anthropic-sdk-v0",
      snapshotName: "anthropic-v0",
      supportsBetaMessages: false,
      supportsServerToolUse: false,
      supportsThinking: false,
      wrapperEntry: "scenario.anthropic-v0273.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "anthropic-sdk-v0-latest",
      snapshotName: "anthropic-v0-latest",
      supportsBetaMessages: true,
      supportsThinking: true,
      wrapperEntry: "scenario.ts",
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
  for (const scenario of anthropicScenarios) {
    describe.sequential(`anthropic sdk ${scenario.version}`, () => {
      defineAnthropicInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { ANTHROPIC_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        supportsBetaMessages: scenario.supportsBetaMessages,
        supportsBetaToolRunner: scenario.supportsBetaToolRunner ?? true,
        supportsServerToolUse: scenario.supportsServerToolUse ?? true,
        supportsThinking: scenario.supportsThinking,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      defineAnthropicInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { ANTHROPIC_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        supportsBetaMessages: scenario.supportsBetaMessages,
        supportsBetaToolRunner: scenario.supportsBetaToolRunner ?? true,
        supportsServerToolUse: scenario.supportsServerToolUse ?? true,
        supportsThinking: scenario.supportsThinking,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
