import { promises as fs } from "node:fs";
import path from "node:path";
import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineFlueInstrumentationAssertions } from "./assertions";
import { defineFlueV2InstrumentationAssertions } from "./v2-assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const generatedScenarioRoot = path.resolve(
  originalScenarioDir,
  "../../.bt-tmp/generated-scenarios/flue-instrumentation",
);
const TIMEOUT_MS = 120_000;
const flueV1ScenarioSourceDir = await prepareGeneratedFlueV1ScenarioSource();
const flueScenarios = await Promise.all([
  prepareFlueScenario({
    cliPackageName: "@flue/cli",
    expectAmbientContext: false,
    label: "v0.8 pinned",
    runtimePackageName: "@flue/runtime",
    sourceDir: originalScenarioDir,
    supportsAutoInstrumentation: true,
    variantKey: "flue-v0-8-0",
  }),
  prepareFlueScenario({
    cliPackageName: "flue-cli-v0-8-latest",
    expectAmbientContext: false,
    label: "v0.8 latest",
    modelName: "openai/gpt-5.4-nano",
    runtimePackageName: "flue-runtime-v0-8-latest",
    sourceDir: originalScenarioDir,
    supportsAutoInstrumentation: true,
    variantKey: "flue-v0-8-latest",
  }),
  prepareFlueScenario({
    cliPackageName: "flue-cli-v1",
    expectAmbientContext: true,
    label: "v1 pinned",
    runtimePackageName: "flue-runtime-v1",
    sourceDir: flueV1ScenarioSourceDir,
    supportsAutoInstrumentation: false,
    variantKey: "flue-v1-0-0-beta-3",
  }),
  prepareFlueScenario({
    cliPackageName: "flue-cli-v1-latest",
    expectAmbientContext: true,
    label: "v1 latest",
    modelName: "openai/gpt-5.4-nano",
    runtimePackageName: "flue-runtime-v1-latest",
    sourceDir: flueV1ScenarioSourceDir,
    supportsAutoInstrumentation: false,
    variantKey: "flue-v1-latest",
  }),
]);
const flueV2ScenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const flueV2Scenarios = await Promise.all(
  [
    {
      dependencyName: "flue-runtime-v2",
      label: "v2 pinned",
      variantKey: "flue-v2",
    },
    {
      dependencyName: "flue-runtime-v2-latest",
      label: "v2 latest",
      variantKey: "flue-v2-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      flueV2ScenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.sequential("flue variants", () => {
  for (const scenario of flueScenarios) {
    describe.sequential(`flue ${scenario.label} (${scenario.version})`, () => {
      defineFlueInstrumentationAssertions({
        expectAmbientContext: scenario.expectAmbientContext,
        name: "explicit instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: "scenario.ts",
            env: scenario.env,
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
              env: scenario.env,
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
              env: {
                ...scenario.env,
                ...(scenario.inputFlag
                  ? { FLUE_E2E_INPUT_FLAG: scenario.inputFlag }
                  : {}),
              },
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

  for (const scenario of flueV2Scenarios) {
    describe.sequential(`flue ${scenario.label} (${scenario.version})`, () => {
      defineFlueV2InstrumentationAssertions({
        originalScenarioDir,
        runtimePackageName: scenario.dependencyName,
        scenarioDir: flueV2ScenarioDir,
        snapshotName: scenario.variantKey,
        testFileUrl: import.meta.url,
        timeoutMs: TIMEOUT_MS,
      });
    });
  }
});

async function prepareFlueScenario(options: {
  cliPackageName: string;
  expectAmbientContext: boolean;
  inputFlag?: string;
  label: string;
  modelName?: string;
  runtimePackageName: string;
  sourceDir: string;
  supportsAutoInstrumentation: boolean;
  variantKey: string;
}) {
  const scenarioDir = await prepareScenarioDir({
    scenarioDir: options.sourceDir,
  });
  const [cliPackageDir, runtimePackageDir] = await Promise.all([
    fs.realpath(path.join(scenarioDir, "node_modules", options.cliPackageName)),
    fs.realpath(
      path.join(scenarioDir, "node_modules", options.runtimePackageName),
    ),
  ]);
  const flueScopeDir = path.join(scenarioDir, "node_modules", "@flue");
  await fs.rm(flueScopeDir, { force: true, recursive: true });
  await fs.mkdir(flueScopeDir, { recursive: true });
  await Promise.all([
    fs.symlink(
      cliPackageDir,
      path.join(flueScopeDir, "cli"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    fs.symlink(
      runtimePackageDir,
      path.join(flueScopeDir, "runtime"),
      process.platform === "win32" ? "junction" : "dir",
    ),
  ]);
  return {
    ...options,
    env: {
      FLUE_CLI_PACKAGE_NAME: options.cliPackageName,
      FLUE_RUNTIME_PACKAGE_NAME: options.runtimePackageName,
      ...(options.modelName
        ? {
            FLUE_E2E_PROMPT_MODEL: options.modelName,
            FLUE_E2E_PROMPT_THINKING_LEVEL: "low",
            FLUE_E2E_REASONING_MODEL: options.modelName,
            FLUE_E2E_REASONING_THINKING_LEVEL: "low",
          }
        : {}),
    },
    scenarioDir,
    version: await readInstalledPackageVersion(
      scenarioDir,
      options.runtimePackageName,
    ),
  };
}

async function prepareGeneratedFlueV1ScenarioSource() {
  const sourceDir = path.join(generatedScenarioRoot, "flue-v1");
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
    filter(source) {
      return (
        source !==
        path.join(originalScenarioDir, "versions", "v1", "package.json")
      );
    },
    recursive: true,
  });
  return sourceDir;
}
