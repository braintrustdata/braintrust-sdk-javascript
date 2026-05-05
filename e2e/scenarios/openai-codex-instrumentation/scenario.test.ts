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
const TIMEOUT_MS = 240_000;
const CODEX_SCENARIO_MODES = ["mock", "real"] as const;
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
  for (const mode of CODEX_SCENARIO_MODES) {
    defineOpenAICodexInstrumentationAssertions({
      mode,
      name: `openai codex sdk ${openAICodexScenario.version} (${mode})`,
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: openAICodexScenario.wrapperEntry,
          env: { OPENAI_CODEX_E2E_MODE: mode },
          runContext: { variantKey: openAICodexScenario.variantKey },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: openAICodexScenario.wrapperSnapshotName,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });
  }
});

describe("auto-hook instrumentation", () => {
  for (const mode of CODEX_SCENARIO_MODES) {
    defineOpenAICodexInstrumentationAssertions({
      mode,
      name: `openai codex sdk ${openAICodexScenario.version} (${mode})`,
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: openAICodexScenario.autoEntry,
          env: { OPENAI_CODEX_E2E_MODE: mode },
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
  }
});
