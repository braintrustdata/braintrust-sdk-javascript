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
      fakeStream: true,
      variantKey: "pi-coding-agent-v0-latest",
      wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
      wrapperSnapshotName: "pi-coding-agent-v0-latest-wrapped",
    },
    {
      autoEntry: "scenario.pi-coding-agent-v079.mjs",
      autoSnapshotName: "pi-coding-agent-v081-auto-hook",
      dependencyName: "pi-coding-agent-v081",
      fakeStream: true,
      variantKey: "pi-coding-agent-v081",
      wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
      wrapperSnapshotName: "pi-coding-agent-v081-wrapped",
    },
    {
      autoEntry: "scenario.pi-coding-agent-v079.mjs",
      autoSnapshotName: "pi-coding-agent-v081-latest-auto-hook",
      dependencyName: "pi-coding-agent-v081-latest",
      fakeStream: true,
      variantKey: "pi-coding-agent-v081-latest",
      wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
      wrapperSnapshotName: "pi-coding-agent-v081-latest-wrapped",
    },
    {
      autoEntry: "scenario.pi-coding-agent-v079.mjs",
      autoSnapshotName: "pi-coding-agent-v1-auto-hook",
      dependencyName: "pi-coding-agent-v1",
      provider: "openai" as const,
      variantKey: "pi-coding-agent-v1",
      wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
      wrapperSnapshotName: "pi-coding-agent-v1-wrapped",
    },
    {
      autoEntry: "scenario.pi-coding-agent-v079.mjs",
      autoSnapshotName: "pi-coding-agent-v1-latest-auto-hook",
      dependencyName: "pi-coding-agent-v1-latest",
      provider: "openai" as const,
      variantKey: "pi-coding-agent-v1-latest",
      wrapperEntry: "scenario.pi-coding-agent-v079-wrapped.mjs",
      wrapperSnapshotName: "pi-coding-agent-v1-latest-wrapped",
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
          provider: piCodingAgentScenario.provider,
          runScenario: async ({ runNodeScenarioDir }) => {
            await runNodeScenarioDir({
              entry: piCodingAgentScenario.wrapperEntry,
              env: {
                PI_CODING_AGENT_PACKAGE_NAME:
                  piCodingAgentScenario.dependencyName,
                ...(piCodingAgentScenario.provider
                  ? { PI_CODING_AGENT_PROVIDER: piCodingAgentScenario.provider }
                  : {}),
                ...(piCodingAgentScenario.fakeStream
                  ? { PI_CODING_AGENT_FAKE_STREAM: "true" }
                  : {}),
              },
              runContext: {
                ...(piCodingAgentScenario.fakeStream
                  ? { cassette: false as const }
                  : {}),
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
          provider: piCodingAgentScenario.provider,
          runScenario: async ({ runNodeScenarioDir }) => {
            await runNodeScenarioDir({
              entry: piCodingAgentScenario.autoEntry,
              env: {
                PI_CODING_AGENT_PACKAGE_NAME:
                  piCodingAgentScenario.dependencyName,
                ...(piCodingAgentScenario.provider
                  ? { PI_CODING_AGENT_PROVIDER: piCodingAgentScenario.provider }
                  : {}),
                ...(piCodingAgentScenario.fakeStream
                  ? { PI_CODING_AGENT_FAKE_STREAM: "true" }
                  : {}),
              },
              nodeArgs: ["--import", "braintrust/hook.mjs"],
              runContext: {
                ...(piCodingAgentScenario.fakeStream
                  ? { cassette: false as const }
                  : {}),
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
