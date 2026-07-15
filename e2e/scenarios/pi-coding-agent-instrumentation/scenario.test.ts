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
const piCodingAgentScenarios = await Promise.all(
  [
    {
      autoEntry: "scenario.pi-coding-agent-v079.mjs",
      autoSnapshotName: "pi-coding-agent-v0-auto-hook",
      dependencyName: "pi-coding-agent-v0",
      variantKey: "pi-coding-agent-v0",
      wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
      wrapperSnapshotName: "pi-coding-agent-v0-wrapped",
    },
    {
      autoEntry: "scenario.pi-coding-agent-v079.mjs",
      autoSnapshotName: "pi-coding-agent-v0-latest-auto-hook",
      dependencyName: "pi-coding-agent-v0-latest",
      variantKey: "pi-coding-agent-v0-latest",
      wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
      wrapperSnapshotName: "pi-coding-agent-v0-latest-wrapped",
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
  for (const piCodingAgentScenario of piCodingAgentScenarios) {
    describe.sequential(
      `pi coding agent ${piCodingAgentScenario.version}`,
      () => {
        definePiCodingAgentInstrumentationAssertions({
          name: "wrapped instrumentation",
          runScenario: async ({ runNodeScenarioDir }) => {
            await runNodeScenarioDir({
              entry: piCodingAgentScenario.wrapperEntry,
              env: {
                PI_CODING_AGENT_PACKAGE_NAME:
                  piCodingAgentScenario.dependencyName,
              },
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

        definePiCodingAgentInstrumentationAssertions({
          name: "auto-hook instrumentation",
          runScenario: async ({ runNodeScenarioDir }) => {
            await runNodeScenarioDir({
              entry: piCodingAgentScenario.autoEntry,
              env: {
                PI_CODING_AGENT_PACKAGE_NAME:
                  piCodingAgentScenario.dependencyName,
              },
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
      },
    );
  }
});
