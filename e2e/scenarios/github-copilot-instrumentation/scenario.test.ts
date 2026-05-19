import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGitHubCopilotInstrumentationAssertions } from "./assertions";
import { GITHUB_COPILOT_SCENARIO_TIMEOUT_MS } from "./constants.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const copilotSdkVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@github/copilot-sdk",
);

describe(`github copilot sdk ${copilotSdkVersion}`, () => {
  defineGitHubCopilotInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          variantKey: "github-copilot-v0-wrapped",
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "github-copilot-v0-wrapped",
    testFileUrl: import.meta.url,
    timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
  });

  defineGitHubCopilotInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: "github-copilot-v0-auto",
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "github-copilot-v0-auto",
    testFileUrl: import.meta.url,
    timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
  });
});
