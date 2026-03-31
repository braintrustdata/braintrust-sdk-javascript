import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineOpenRouterTraceAssertions } from "./assertions";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const openrouterSdkVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@openrouter/sdk",
);
const OPENROUTER_VARIANT_KEY = "openrouter-current";
const TIMEOUT_MS = 90_000;

describe(`openrouter sdk ${openrouterSdkVersion}`, () => {
  defineOpenRouterTraceAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: { variantKey: OPENROUTER_VARIANT_KEY },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });

  defineOpenRouterTraceAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: OPENROUTER_VARIANT_KEY },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
