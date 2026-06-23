import { promises as fs } from "node:fs";
import path from "node:path";
import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineFlueInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const generatedScenarioRoot = path.resolve(
  originalScenarioDir,
  "../../.bt-tmp/generated-scenarios/flue-instrumentation",
);
const TIMEOUT_MS = 120_000;
const flueScenarios = await Promise.all([
  prepareFlueScenario({
    expectAmbientContext: false,
    label: "v0.8.0",
    sourceDir: originalScenarioDir,
    supportsAutoInstrumentation: true,
    variantKey: "flue-v0-8-0",
  }),
  prepareGeneratedFlueV1Scenario(),
]);

describe.sequential("flue variants", () => {
  for (const scenario of flueScenarios) {
    describe.sequential(`flue ${scenario.label} (${scenario.version})`, () => {
      defineFlueInstrumentationAssertions({
        expectAmbientContext: scenario.expectAmbientContext,
        name: "explicit instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            runContext: {
              originalScenarioDir,
              variantKey: scenario.variantKey,
            },
            scenarioDir: scenario.scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });
        },
        snapshotName: `${scenario.variantKey}-explicit`,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });

      if (scenario.supportsAutoInstrumentation) {
        defineFlueInstrumentationAssertions({
          expectAmbientContext: scenario.expectAmbientContext,
          name: "auto-hook instrumentation",
          runScenario: async ({ runNodeScenarioDir }) => {
            await runNodeScenarioDir({
              entry: "scenario.mjs",
              nodeArgs: ["--import", "braintrust/hook.mjs"],
              runContext: {
                originalScenarioDir,
                variantKey: scenario.variantKey,
              },
              scenarioDir: scenario.scenarioDir,
              timeoutMs: TIMEOUT_MS,
            });
          },
          snapshotName: `${scenario.variantKey}-auto-hook`,
          testFileUrl: import.meta.url,
          timeoutMs: TIMEOUT_MS,
        });

        defineFlueInstrumentationAssertions({
          expectAmbientContext: scenario.expectAmbientContext,
          name: "cli instrumentation",
          runScenario: async ({ runNodeScenarioDir }) => {
            await runNodeScenarioDir({
              entry: "scenario.cli.mjs",
              env: scenario.inputFlag
                ? { FLUE_E2E_INPUT_FLAG: scenario.inputFlag }
                : undefined,
              runContext: {
                originalScenarioDir,
                variantKey: scenario.variantKey,
              },
              scenarioDir: scenario.scenarioDir,
              timeoutMs: TIMEOUT_MS,
            });
          },
          snapshotName: `${scenario.variantKey}-cli`,
          testFileUrl: import.meta.url,
          timeoutMs: TIMEOUT_MS,
        });
      }
    });
  }
});

async function prepareFlueScenario(options: {
  expectAmbientContext: boolean;
  inputFlag?: string;
  label: string;
  sourceDir: string;
  supportsAutoInstrumentation: boolean;
  variantKey: string;
}) {
  const scenarioDir = await prepareScenarioDir({
    scenarioDir: options.sourceDir,
  });
  return {
    ...options,
    scenarioDir,
    version: await readInstalledPackageVersion(scenarioDir, "@flue/runtime"),
  };
}

async function prepareGeneratedFlueV1Scenario() {
  const sourceDir = path.join(generatedScenarioRoot, "flue-v1-0-0-beta-3");
  await fs.rm(sourceDir, { force: true, recursive: true });
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.cp(originalScenarioDir, sourceDir, {
    filter(source) {
      const relative = path.relative(originalScenarioDir, source);
      return (
        relative === "" ||
        !["__cassettes__", "__snapshots__", "node_modules", "versions"].some(
          (name) =>
            relative === name || relative.startsWith(`${name}${path.sep}`),
        )
      );
    },
    recursive: true,
  });
  await fs.cp(path.join(originalScenarioDir, "versions", "v1"), sourceDir, {
    recursive: true,
  });

  return prepareFlueScenario({
    expectAmbientContext: true,
    label: "v1.0.0-beta.3",
    sourceDir,
    supportsAutoInstrumentation: false,
    variantKey: "flue-v1-0-0-beta-3",
  });
}
