import { describe } from "vite-plus/test";
import { describeVariant } from "../../helpers/describe-variant";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineTypeSafeInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

const scenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.cjs-client.mjs",
      dependencyName: "typesafe-sdk-v0",
      snapshotName: "typesafe-v0",
      supportsImages: false,
      wrapperEntry: "scenario.cjs-client.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "typesafe-sdk-v0-latest",
      snapshotName: "typesafe-v0-latest",
      supportsImages: false,
      wrapperEntry: "scenario.ts",
    },
    {
      autoEntry: "scenario.cjs-client.mjs",
      dependencyName: "typesafe-sdk-v0-7",
      snapshotName: "typesafe-v0-7",
      supportsImages: true,
      wrapperEntry: "scenario.cjs-client.ts",
    },
    {
      autoEntry: "scenario.mjs",
      dependencyName: "typesafe-sdk-v0-7-latest",
      snapshotName: "typesafe-v0-7-latest",
      supportsImages: true,
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

describe.concurrent("variants", () => {
  for (const scenario of scenarios) {
    describeVariant(`typesafe sdk ${scenario.version}`, () => {
      const env = {
        TYPESAFE_PACKAGE_NAME: scenario.dependencyName,
        TYPESAFE_SUPPORTS_IMAGES: scenario.supportsImages ? "1" : "0",
      };
      const runContext = {
        originalScenarioDir,
        variantKey: scenario.snapshotName,
      };

      defineTypeSafeInstrumentationAssertions({
        name: "wrapped instrumentation",
        runScenario: async ({ runScenarioDir }) => {
          await runScenarioDir({
            entry: scenario.wrapperEntry,
            env,
            runContext,
            scenarioDir,
          });
        },
        snapshotName: `${scenario.snapshotName}-wrapped`,
        supportsImages: scenario.supportsImages,
        testFileUrl: import.meta.url,
      });

      defineTypeSafeInstrumentationAssertions({
        name: "auto-hook instrumentation",
        runScenario: async ({ runNodeScenarioDir }) => {
          await runNodeScenarioDir({
            entry: scenario.autoEntry,
            env,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            runContext,
            scenarioDir,
          });
        },
        snapshotName: scenario.snapshotName,
        supportsImages: scenario.supportsImages,
        testFileUrl: import.meta.url,
      });
    });
  }
});
