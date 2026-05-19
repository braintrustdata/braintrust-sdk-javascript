import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAICodexInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 240_000;
const openAICodexScenario = {
  autoEntry: "scenario.openai-codex-v0128.mjs",
  autoSnapshotName: "openai-codex-v0128-auto-hook",
  dependencyName: "openai-codex-sdk-v0128",
  version: await readInstalledPackageVersion(
    scenarioDir,
    "openai-codex-sdk-v0128",
  ),
  wrapperEntry: "scenario.openai-codex-v0128.ts",
  wrapperSnapshotName: "openai-codex-v0128-wrapped",
};

describe(`openai codex sdk ${openAICodexScenario.version}`, () => {
  defineOpenAICodexInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: openAICodexScenario.wrapperEntry,
        runContext: {
          variantKey: openAICodexScenario.wrapperSnapshotName,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: openAICodexScenario.wrapperSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  defineOpenAICodexInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: openAICodexScenario.autoEntry,
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: openAICodexScenario.autoSnapshotName,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: openAICodexScenario.autoSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
