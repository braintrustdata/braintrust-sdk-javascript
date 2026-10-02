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
      cassetteKey: "anthropic-v0",
      dependencyName: "anthropic-sdk-v0",
      snapshotName: "anthropic-v0",
      supportsBetaMessages: false,
      supportsBetaToolRunner: false,
      supportsSessions: false,
      supportsServerToolUse: false,
      supportsThinking: false,
      wrapperEntry: "scenario.anthropic-v0273.ts",
    },
    {
      autoEntry: "scenario.anthropic-v0330.mjs",
      cassetteKey: "anthropic-v0-batches",
      dependencyName: "anthropic-sdk-v0-batches",
      snapshotName: "anthropic-v0-batches",
      supportsBatches: true,
      supportsBetaMessages: true,
      supportsBetaMessagesStream: false,
      supportsBetaToolRunner: false,
      supportsSessions: false,
      supportsServerToolUse: false,
      supportsThinking: false,
      wrapperEntry: "scenario.anthropic-v0330.ts",
    },
    {
      autoEntry: "scenario.mjs",
      cassetteKey: "anthropic-v0-latest",
      dependencyName: "anthropic-sdk-v0-latest",
      snapshotName: "anthropic-v0-latest",
      supportsBatches: true,
      supportsBetaMessages: true,
      supportsBetaToolRunner: true,
      supportsSessions: true,
      supportsServerToolUse: true,
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
              cassette: { variantKey: scenario.cassetteKey },
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.supportsSessions
          ? `${scenario.snapshotName}-wrapped`
          : scenario.snapshotName,
        supportsBatches: scenario.supportsBatches ?? false,
        supportsBetaMessages: scenario.supportsBetaMessages,
        supportsBetaMessagesStream: scenario.supportsBetaMessagesStream ?? true,
        supportsBetaToolRunner: scenario.supportsBetaToolRunner ?? true,
        supportsSessions: scenario.supportsSessions,
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
              cassette: { variantKey: scenario.cassetteKey },
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.snapshotName,
        supportsBatches: scenario.supportsBatches ?? false,
        supportsBetaMessages: scenario.supportsBetaMessages,
        supportsBetaMessagesStream: scenario.supportsBetaMessagesStream ?? true,
        supportsBetaToolRunner: scenario.supportsBetaToolRunner ?? true,
        supportsSessions: scenario.supportsSessions,
        supportsServerToolUse: scenario.supportsServerToolUse ?? true,
        supportsThinking: scenario.supportsThinking,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
