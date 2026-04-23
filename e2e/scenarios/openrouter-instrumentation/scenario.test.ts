import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenRouterTraceAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;
const openRouterScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.openrouter-v0911.mjs",
      dependencyName: "openrouter-sdk-v0911",
      snapshotName: "openrouter-v0911",
      supportsRerank: false,
      wrapperEntry: "scenario.openrouter-v0911.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "@openrouter/sdk",
      snapshotName: "openrouter-v0123",
      supportsRerank: true,
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

for (const scenario of openRouterScenarios) {
  describe(`openrouter sdk ${scenario.version}`, () => {
    defineOpenRouterTraceAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsRerank: scenario.supportsRerank,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });

    defineOpenRouterTraceAssertions({
      name: "auto-hook instrumentation",
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          runContext: { variantKey: scenario.snapshotName },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsRerank: scenario.supportsRerank,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });
  });
}
