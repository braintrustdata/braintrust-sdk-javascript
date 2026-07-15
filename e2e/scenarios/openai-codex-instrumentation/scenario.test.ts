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
const openAICodexScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.openai-codex-v0128.mjs",
      autoSnapshotName: "openai-codex-v0-auto-hook",
      dependencyName: "openai-codex-sdk-v0",
      wrapperEntry: "scenario.openai-codex-v0128.ts",
      wrapperSnapshotName: "openai-codex-v0-wrapped",
    },
    {
      autoEntry: "scenario.openai-codex-v0128.mjs",
      autoSnapshotName: "openai-codex-v0-latest-auto-hook",
      dependencyName: "openai-codex-sdk-v0-latest",
      wrapperEntry: "scenario.openai-codex-v0128.ts",
      wrapperSnapshotName: "openai-codex-v0-latest-wrapped",
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
  for (const scenario of openAICodexScenarios) {
    describe.sequential(`openai codex sdk ${scenario.version}`, () => {
      defineOpenAICodexInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { OPENAI_CODEX_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.wrapperSnapshotName,
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

      defineOpenAICodexInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { OPENAI_CODEX_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.autoSnapshotName,
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
