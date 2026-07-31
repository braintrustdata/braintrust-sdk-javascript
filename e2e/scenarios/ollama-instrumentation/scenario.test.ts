import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOllamaInstrumentationAssertions } from "./assertions";
import { OLLAMA_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const ollamaScenarios = await Promise.all(
  [
    {
      dependencyName: "ollama-v0-6",
      variantKey: "ollama-v0.6",
    },
    {
      dependencyName: "ollama-v0-6-latest",
      variantKey: "ollama-v0.6-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.sequential("variants", () => {
  for (const scenario of ollamaScenarios) {
    describe.sequential(`ollama sdk ${scenario.version}`, () => {
      defineOllamaInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: { OLLAMA_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: OLLAMA_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.variantKey}-wrapped`,
        testFileUrl: import.meta.url,
        timeoutMs: OLLAMA_SCENARIO_TIMEOUT_MS,
      });

      defineOllamaInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: { OLLAMA_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: OLLAMA_SCENARIO_TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.variantKey}-auto`,
        testFileUrl: import.meta.url,
        timeoutMs: OLLAMA_SCENARIO_TIMEOUT_MS,
      });
    });
  }
});
