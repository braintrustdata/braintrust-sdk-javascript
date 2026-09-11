import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAIAgentsAPIInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 180_000;
const scenarios = await Promise.all(
  [
    {
      dependencyName: "openai-agents-api-v7",
      variantKey: "openai-agents-api-v7",
    },
    {
      dependencyName: "openai-agents-api-v7-latest",
      variantKey: "openai-agents-api-v7-latest",
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
  for (const scenario of scenarios) {
    describe.sequential(
      `${scenario.variantKey}: OpenAI Agents API SDK ${scenario.version}`,
      () => {
        defineOpenAIAgentsAPIInstrumentationAssertions({
          name: "manual instrumentation",
          runScenario: async ({ runScenarioDir }) => {
            await runScenarioDir({
              entry: "scenario.mjs",
              env: {
                OPENAI_AGENTS_API_PACKAGE_NAME: scenario.dependencyName,
              },
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
      },
    );
  }
});
