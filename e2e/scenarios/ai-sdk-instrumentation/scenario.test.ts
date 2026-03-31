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

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
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

for (const scenario of aiSDKScenarios) {
  const sdkMajorVersion = parseMajorVersion(scenario.version);
  const supportsRichInputScenarios = sdkMajorVersion >= 5;
  const supportsOutputObjectScenario = supportsRichInputScenarios;
  const supportsAttachmentScenario = supportsRichInputScenarios;

  describe(`ai sdk ${scenario.version}`, () => {
    defineAISDKInstrumentationAssertions({
      agentSpanName: scenario.agentSpanName,
      name: "wrapped instrumentation",
      runScenario: async ({ runScenarioDir }) => {
        await runScenarioDir({
          entry: scenario.wrapperEntry,
          scenarioDir,
          timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsAttachmentScenario,
      supportsDenyOutputOverrideScenario: supportsRichInputScenarios,
      supportsGenerateObject: scenario.supportsGenerateObject,
      supportsOutputObjectScenario,
      supportsStreamObject: scenario.supportsStreamObject,
      supportsToolExecution: scenario.supportsToolExecution,
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
          scenarioDir,
          timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
        });
      },
      snapshotName: scenario.snapshotName,
      supportsAttachmentScenario,
      supportsDenyOutputOverrideScenario: supportsRichInputScenarios,
      supportsGenerateObject: scenario.supportsGenerateObject,
      supportsOutputObjectScenario,
      supportsStreamObject: scenario.supportsStreamObject,
      supportsToolExecution: scenario.supportsToolExecution,
      testFileUrl: import.meta.url,
      timeoutMs: AI_SDK_SCENARIO_TIMEOUT_MS,
    });
  });
}
