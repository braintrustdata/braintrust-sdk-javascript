import { describe } from "vitest";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
} from "../../helpers/scenario-harness";
import { definePiCodingAgentInstrumentationAssertions } from "./assertions";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 240_000;
const piCodingAgentScenario = {
  autoEntry: "scenario.pi-coding-agent-v079.mjs",
  autoSnapshotName: "pi-coding-agent-v079-auto-hook",
  dependencyName: "pi-coding-agent-v079",
  version: await readInstalledPackageVersion(
    scenarioDir,
    "pi-coding-agent-v079",
  ),
  wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
  wrapperSnapshotName: "pi-coding-agent-v079-wrapped",
  variantKey: "pi-coding-agent-v079",
};

describe("wrapped instrumentation", () => {
  definePiCodingAgentInstrumentationAssertions({
    name: `pi coding agent ${piCodingAgentScenario.version}`,
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: piCodingAgentScenario.wrapperEntry,
        runContext: {
          variantKey: piCodingAgentScenario.variantKey,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: piCodingAgentScenario.wrapperSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});

describe("auto-hook instrumentation", () => {
  definePiCodingAgentInstrumentationAssertions({
    name: `pi coding agent ${piCodingAgentScenario.version}`,
    runScenario: async ({ runNodeScenarioDir }) => {
      await runNodeScenarioDir({
        entry: piCodingAgentScenario.autoEntry,
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: {
          variantKey: piCodingAgentScenario.variantKey,
          originalScenarioDir,
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });
    },
    snapshotName: piCodingAgentScenario.autoSnapshotName,
    testFileUrl: import.meta.url,
    timeoutMs: TIMEOUT_MS,
  });
});
