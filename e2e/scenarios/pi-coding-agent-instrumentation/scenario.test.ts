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
    { dependencyName: "pi-coding-agent-v0", provider: "anthropic" as const },
    {
      dependencyName: "pi-coding-agent-v0-latest",
      provider: "anthropic" as const,
    },
    { dependencyName: "pi-coding-agent-v081", provider: "anthropic" as const },
    {
      dependencyName: "pi-coding-agent-v081-latest",
      provider: "anthropic" as const,
    },
    { dependencyName: "pi-coding-agent-v1", provider: "openai" as const },
    {
      dependencyName: "pi-coding-agent-v1-latest",
      provider: "openai" as const,
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
      `${piCodingAgentScenario.dependencyName} (${piCodingAgentScenario.version})`,
      () => {
        for (const mode of [
          {
            name: "wrapped instrumentation",
            entry: "scenario.pi-coding-agent-v079-wrapped.mjs",
            suffix: "wrapped",
            nodeArgs: [],
          },
          {
            name: "auto-hook instrumentation",
            entry: "scenario.pi-coding-agent-v079.mjs",
            suffix: "auto-hook",
            nodeArgs: ["--import", "braintrust/hook.mjs"],
          },
        ]) {
          definePiCodingAgentInstrumentationAssertions({
            name: mode.name,
            provider: piCodingAgentScenario.provider,
            runScenario: async ({ runNodeScenarioDir }) => {
              await runNodeScenarioDir({
                entry: mode.entry,
                nodeArgs: mode.nodeArgs,
                env: {
                  PI_CODING_AGENT_PACKAGE_NAME:
                    piCodingAgentScenario.dependencyName,
                  PI_CODING_AGENT_PROVIDER: piCodingAgentScenario.provider,
                },
                runContext: {
                  variantKey: piCodingAgentScenario.dependencyName,
                  originalScenarioDir,
                },
                scenarioDir,
                timeoutMs: TIMEOUT_MS,
              });
            },
            snapshotName: `${piCodingAgentScenario.dependencyName}-${mode.suffix}`,
            testFileUrl: import.meta.url,
            timeoutMs: TIMEOUT_MS,
          });
        }
      },
    );
  }
});
