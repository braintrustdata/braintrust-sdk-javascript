import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineAnthropicInstrumentationAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;
const anthropicScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.anthropic-v0273.mjs",
      dependencyName: "anthropic-sdk-v0273",
      snapshotName: "anthropic-v0273",
      supportsBetaMessages: false,
      wrapperEntry: "scenario.anthropic-v0273.ts",
    },
    {
      autoEntry: "scenario.anthropic-v0390.mjs",
      dependencyName: "anthropic-sdk-v0390",
      snapshotName: "anthropic-v0390",
      supportsBetaMessages: true,
      wrapperEntry: "scenario.anthropic-v0390.ts",
    },
    {
      autoEntry: "scenario.anthropic-v0712.mjs",
      dependencyName: "anthropic-sdk-v0712",
      snapshotName: "anthropic-v0712",
      supportsBetaMessages: true,
      wrapperEntry: "scenario.anthropic-v0712.ts",
    },
    {
      autoEntry: "scenario.anthropic-v0730.mjs",
      dependencyName: "anthropic-sdk-v0730",
      snapshotName: "anthropic-v0730",
      supportsBetaMessages: true,
      wrapperEntry: "scenario.anthropic-v0730.ts",
    },
    {
      autoEntry: "scenario.anthropic-v0780.mjs",
      dependencyName: "anthropic-sdk-v0780",
      snapshotName: "anthropic-v0780",
      supportsBetaMessages: true,
      wrapperEntry: "scenario.anthropic-v0780.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "@anthropic-ai/sdk",
      snapshotName: "anthropic-v0800",
      supportsBetaMessages: true,
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

for (const scenario of anthropicScenarios) {
  describe(`anthropic sdk ${scenario.version}`, () => {
    defineAnthropicInstrumentationAssertions({
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsBetaMessages: scenario.supportsBetaMessages,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });

    defineAnthropicInstrumentationAssertions({
      name: "auto-hook instrumentation",
      runScenario: async ({ runNodeScenarioDir }) => {
        await runNodeScenarioDir({
          entry: scenario.autoEntry,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsBetaMessages: scenario.supportsBetaMessages,
      testFileUrl: import.meta.url,
      timeoutMs: TIMEOUT_MS,
    });
  });
}
