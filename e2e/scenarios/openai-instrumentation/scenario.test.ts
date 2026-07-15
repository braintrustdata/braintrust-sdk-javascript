import { describe, it } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  runNodeScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenAIInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;
const openaiScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.openai-v4.mjs",
      dependencyName: "openai-v4",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v4",
      wrapperEntry: "scenario.openai-v4.ts",
    },
    {
      autoEntry: "scenario.openai-v4.mjs",
      dependencyName: "openai-v4-latest",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v4-latest",
      wrapperEntry: "scenario.openai-v4.ts",
    },
    {
      autoEntry: "scenario.openai-v5.mjs",
      dependencyName: "openai-v5",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v5",
      wrapperEntry: "scenario.openai-v5.ts",
    },
    {
      autoEntry: "scenario.openai-v5.mjs",
      dependencyName: "openai-v5-latest",
      disablePrivateFieldMethodsAssertion: true,
      snapshotName: "openai-v5-latest",
      wrapperEntry: "scenario.openai-v5.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openai-v6",
      snapshotName: "openai-v6",
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "openai-v6-latest",
      snapshotName: "openai-v6-latest",
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

// Regression test: verify hook.mjs doesn't cause "Body already read" with real undici responses.
// The cassette layer returns in-process Response mocks that mask this bug; this test bypasses it.
describe("real HTTP server (undici responses)", () => {
  it(
    "hook.mjs does not cause 'Body already read' on non-streaming create()",
    async () => {
      await runNodeScenarioDir({
        entry: "scenario.real-http.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    TIMEOUT_MS,
  );
});

describe.concurrent("variants", () => {
  for (const scenario of openaiScenarios) {
    const assertPrivateFieldMethodsOperation =
      !scenario.disablePrivateFieldMethodsAssertion;

    describe.sequential(`openai sdk ${scenario.version}`, () => {
      defineOpenAIInstrumentationAssertions({
        assertPrivateFieldMethodsOperation,
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env: { OPENAI_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        cassetteName: scenario.snapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
        version: scenario.version,
      });

      defineOpenAIInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env: { OPENAI_PACKAGE_NAME: scenario.dependencyName },
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext: {
              variantKey: scenario.snapshotName,
              originalScenarioDir,
            },
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.snapshotName}-auto-hook`,
        cassetteName: scenario.snapshotName,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
        version: scenario.version,
      });
    });
  }
});
