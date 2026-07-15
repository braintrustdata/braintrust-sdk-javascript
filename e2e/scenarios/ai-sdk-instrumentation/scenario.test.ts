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

const describeVariants =
  process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record" ||
  process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record-missing"
    ? describe.sequential
    : describe.concurrent;

describeVariants("variants", () => {
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
            env: {
              AI_SDK_PACKAGE_NAME: scenario.packageName,
              AI_SDK_OPENAI_PACKAGE_NAME: scenario.openaiModuleName,
              ...(scenario.anthropicModuleName
                ? {
                    AI_SDK_ANTHROPIC_PACKAGE_NAME: scenario.anthropicModuleName,
                  }
                : {}),
              ...(scenario.cohereModuleName
                ? { AI_SDK_COHERE_PACKAGE_NAME: scenario.cohereModuleName }
                : {}),
              ...(scenario.workflowModuleName
                ? { AI_SDK_WORKFLOW_PACKAGE_NAME: scenario.workflowModuleName }
                : {}),
              ...(scenario.workflowAIModuleName
                ? {
                    AI_SDK_WORKFLOW_AI_PACKAGE_NAME:
                      scenario.workflowAIModuleName,
                  }
                : {}),
            },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-${scenario.wrapperSnapshotSuffix ?? "wrapped"}`,
        supportsAgentToolLoop: scenario.supportsAgentToolLoop === true,
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
        supportsWorkflowAgent: scenario.supportsWorkflowAgent,
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
            env: {
              AI_SDK_PACKAGE_NAME: scenario.packageName,
              AI_SDK_OPENAI_PACKAGE_NAME: scenario.openaiModuleName,
              ...(scenario.anthropicModuleName
                ? {
                    AI_SDK_ANTHROPIC_PACKAGE_NAME: scenario.anthropicModuleName,
                  }
                : {}),
              ...(scenario.cohereModuleName
                ? { AI_SDK_COHERE_PACKAGE_NAME: scenario.cohereModuleName }
                : {}),
              ...(scenario.workflowModuleName
                ? { AI_SDK_WORKFLOW_PACKAGE_NAME: scenario.workflowModuleName }
                : {}),
              ...(scenario.workflowAIModuleName
                ? {
                    AI_SDK_WORKFLOW_AI_PACKAGE_NAME:
                      scenario.workflowAIModuleName,
                  }
                : {}),
            },
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
        supportsAgentToolLoop: scenario.supportsAgentToolLoop === true,
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
        supportsWorkflowAgent: scenario.supportsWorkflowAgent,
        sdkMajorVersion,
        testFileUrl: import.meta.url,
        timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
