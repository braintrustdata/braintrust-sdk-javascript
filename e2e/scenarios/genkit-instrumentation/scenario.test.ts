import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { cassetteTagsForAll } from "../../helpers/tags";
import { defineGenkitInstrumentationAssertions } from "./assertions";
import { GENKIT_SCENARIO_TIMEOUT_MS } from "./scenario.impl.mjs";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

const genkitVersion = await readInstalledPackageVersion(scenarioDir, "genkit");
const snapshotName = `genkit-v${genkitVersion.replace(/\./g, "-")}`;
const wrappedSnapshotName = `${snapshotName}-wrapped`;
const autoSnapshotName = `${snapshotName}-auto`;
const tags = cassetteTagsForAll(import.meta.url, [
  wrappedSnapshotName,
  autoSnapshotName,
]);

describe(`genkit ${genkitVersion}`, { tags }, () => {
  defineGenkitInstrumentationAssertions({
    name: "wrapped instrumentation",
    runScenario: async ({ runScenarioDir }) => {
      await runScenarioDir({
        entry: "scenario.ts",
        runContext: {
          variantKey: snapshotName,
          cassette: { variantKey: wrappedSnapshotName },
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: wrappedSnapshotName,
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
        runContext: {
          variantKey: snapshotName,
          cassette: { variantKey: autoSnapshotName },
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
      });
    },
    snapshotName: autoSnapshotName,
    supportsActionSpans: true,
    testFileUrl: import.meta.url,
    timeoutMs: GENKIT_SCENARIO_TIMEOUT_MS,
  });
});
