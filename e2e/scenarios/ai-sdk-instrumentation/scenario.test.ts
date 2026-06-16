import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineAISDKInstrumentationAssertions } from "./assertions";
import {
  AI_SDK_SCENARIO_SPECS,
  AI_SDK_SCENARIO_TIMEOUT_MS,
} from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const aiSDKScenarios = await Promise.all(
  AI_SDK_SCENARIO_SPECS.map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

function parseMajorVersion(version: string): number {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

describe.concurrent("variants", () => {
  for (const scenario of aiSDKScenarios) {
    const sdkMajorVersion = parseMajorVersion(scenario.version);
    const supportsRichInputScenarios = sdkMajorVersion >= 5;
    const supportsDenyOutputOverrideScenario =
      scenario.supportsDenyOutputOverrideScenario ?? supportsRichInputScenarios;
    const supportsOpenAICacheAssertions =
      (scenario.supportsOpenAICacheScenario ?? supportsRichInputScenarios) &&
      sdkMajorVersion >= 5;
    const supportsOutputObjectScenario =
      scenario.supportsOutputObjectScenario ?? supportsRichInputScenarios;

    describe.sequential(`ai sdk ${scenario.version}`, () => {
      defineAISDKInstrumentationAssertions({
        agentSpanName: scenario.agentSpanName,
        name: scenario.wrapperTestName ?? "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-${scenario.wrapperSnapshotSuffix ?? "wrapped"}`,
        supportsOpenAICacheAssertions,
        supportsProviderCacheAssertions:
          scenario.supportsProviderCacheAssertions,
        supportsDenyOutputOverrideScenario,
        supportsEmbedMany: scenario.supportsEmbedMany !== false,
        supportsGenerateObject: scenario.supportsGenerateObject,
        supportsOutputObjectScenario,
        supportsRerank: scenario.supportsRerank !== false,
        supportsStreamObject: scenario.supportsStreamObject,
        supportsToolExecution: scenario.supportsToolExecution,
        sdkMajorVersion,
        testFileUrl: import.meta.url,
        timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
      });

      defineAISDKInstrumentationAssertions({
        agentSpanName: scenario.agentSpanName,
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-hook`,
        supportsOpenAICacheAssertions,
        supportsProviderCacheAssertions:
          scenario.supportsProviderCacheAssertions,
        supportsDenyOutputOverrideScenario,
        supportsEmbedMany: scenario.supportsEmbedMany !== false,
        supportsGenerateObject: scenario.supportsGenerateObject,
        supportsOutputObjectScenario,
        supportsRerank: scenario.supportsRerank !== false,
        supportsStreamObject: scenario.supportsStreamObject,
        supportsToolExecution: scenario.supportsToolExecution,
        sdkMajorVersion,
        testFileUrl: import.meta.url,
        timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
