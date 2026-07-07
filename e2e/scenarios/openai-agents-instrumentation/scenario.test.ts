import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAIAgentsAutoInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 60_000;
const openAIAgentsScenarios = await Promise.all(
  [
    {
      dependencyName: "openai-agents-v0",
      variantKey: "openai-agents-v0",
    },
    {
      dependencyName: "openai-agents-v0-latest",
      variantKey: "openai-agents-v0-latest",
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
  for (const scenario of openAIAgentsScenarios) {
    describe.sequential(`openai agents sdk ${scenario.version}`, () => {
      defineOpenAIAgentsAutoInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: "scenario.mjs",
            env: {
              NODE_ENV: "development",
              OPENAI_AGENTS_PACKAGE_NAME: scenario.dependencyName,
            },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: scenario.variantKey,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});
