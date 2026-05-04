import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { defineGenkitInstrumentationAssertions } from "./assertions";
import { GENKIT_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

const genkitVersion = await readInstalledPackageVersion(scenarioDir, "genkit");
const snapshotName = `genkit-v${genkitVersion.replace(/\./g, "-")}`;

describe(`genkit ${genkitVersion}`, () => {
  defineGenkitInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: { variantKey: snapshotName },
        scenarioDir,
        timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: `${snapshotName}-wrapped`,
    supportsActionSpans: true,
    testFileUrl: import.meta.url,
    timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
  });

  defineGenkitInstrumentationAssertions({
    name: "auto-hook instrumentation",
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: snapshotName },
        scenarioDir,
        timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: `${snapshotName}-auto`,
    supportsActionSpans: false,
    testFileUrl: import.meta.url,
    timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
  });
});
