import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGroqInstrumentationAssertions } from "./assertions";
import { GROQ_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const groqSdkVersion = await readInstalledPackageVersion(
  scenarioDir,
  "groq-sdk",
);

describe(`groq sdk ${groqSdkVersion}`, () => {
  defineGroqInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: { variantKey: "groq-v1-wrapped" },
        scenarioDir,
        timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "groq-v1-wrapped",
    testFileUrl: import.meta.url,
    timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
  });

  defineGroqInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: "groq-v1-auto" },
        scenarioDir,
        timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: "groq-v1-auto",
    testFileUrl: import.meta.url,
    timeoutMs: GROQ_SCENARIO_TIMEOUT_MS,
  });
});
