import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAICodexInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 120_000;
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
  variantKey: "openai-codex-v0128",
};

describe("wrapped instrumentation", () => {
  defineOpenAICodexInstrumentationAssertions({
    name: `openai codex sdk ${openAICodexScenario.version}`,
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: openAICodexScenario.wrapperEntry,
        runContext: { variantKey: openAICodexScenario.variantKey },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: openAICodexScenario.wrapperSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});

describe("auto-hook instrumentation", () => {
  defineOpenAICodexInstrumentationAssertions({
    name: `openai codex sdk ${openAICodexScenario.version}`,
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: openAICodexScenario.autoEntry,
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: openAICodexScenario.variantKey },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: openAICodexScenario.autoSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
