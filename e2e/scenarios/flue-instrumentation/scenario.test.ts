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
const TIMEOUT_MS = 120_000;
const flueScenarios = await Promise.all([
  prepareFlueScenario({
    cliPackageName: "@flue/cli",
    expectAmbientContext: true,
    label: "v1 pinned",
    runtimePackageName: "@flue/runtime",
    variantKey: "flue-v1-0-0-beta-3",
  }),
  prepareFlueScenario({
    cliPackageName: "flue-cli-v1-latest",
    expectAmbientContext: true,
    label: "v1 latest",
    modelName: "openai/gpt-5.4-nano",
    runtimePackageName: "flue-runtime-v1-latest",
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
  label: string;
  modelName?: string;
  runtimePackageName: string;
  variantKey: string;
}) {
  const scenarioDir = await prepareScenarioDir({
    scenarioDir: originalScenarioDir,
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
