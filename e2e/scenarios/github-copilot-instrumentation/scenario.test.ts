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
const githubCopilotScenarios = await Promise.all(
  [
    {
      dependencyName: "github-copilot-sdk-v0",
      snapshotName: "github-copilot-v0",
    },
    {
      dependencyName: "github-copilot-sdk-v0-latest",
      snapshotName: "github-copilot-v0-latest",
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
  for (const scenario of githubCopilotScenarios) {
    describe.sequential(`github copilot sdk ${scenario.version}`, () => {
      defineGitHubCopilotInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: { GITHUB_COPILOT_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
      });

      defineGitHubCopilotInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: { GITHUB_COPILOT_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto`,
        testFileUrl: import.meta.url,
        timeoutMs: GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
