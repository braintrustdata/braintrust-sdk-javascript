import { describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findAllSpans } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const TIMEOUT_MS = 120_000;
const turnNames = [
  "HarnessAgent.generate",
  "HarnessAgent.stream",
  "HarnessAgent.continueGenerate",
  "HarnessAgent.continueStream",
] as const;
// The 1.0.0 Codex adapter supports suspended-turn replay against both Harness
// baselines; newer adapter releases abort the active turn during suspension.
const scenarios = await Promise.all(
  [
    {
      codexDependencyName: "ai-sdk-harness-codex-v1",
      dependencyName: "ai-sdk-harness-v1",
      variantKey: "ai-sdk-harness-v1",
    },
    {
      codexDependencyName: "ai-sdk-harness-codex-v1",
      dependencyName: "ai-sdk-harness-v1-latest",
      variantKey: "ai-sdk-harness-v1-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);

describe.sequential("HarnessAgent instrumentation variants", () => {
  for (const scenario of scenarios) {
    describe.sequential(`@ai-sdk/harness ${scenario.version}`, () => {
      for (const mode of ["wrapped", "auto-hook"] as const) {
        test(mode, { timeout: TIMEOUT_MS }, async () => {
          await withScenarioHarness(async (harness) => {
            const runContext = {
              variantKey: scenario.variantKey,
              originalScenarioDir,
            };
            const env = {
              AI_SDK_HARNESS_CODEX_PACKAGE_NAME: scenario.codexDependencyName,
              AI_SDK_HARNESS_PACKAGE_NAME: scenario.dependencyName,
            };
            if (mode === "wrapped") {
              await harness.runScenarioDir({
                entry: "scenario.ts",
                env,
                runContext,
                scenarioDir,
                timeoutMs: TIMEOUT_MS,
              });
            } else {
              await harness.runNodeScenarioDir({
                entry: "scenario.mjs",
                env,
                nodeArgs: ["--import", "braintrust/hook.mjs"],
                runContext,
                scenarioDir,
                timeoutMs: TIMEOUT_MS,
              });
            }

            const events = harness.events();
            const turns = turnNames.flatMap((name) =>
              findAllSpans(events, name),
            );
            const turnsByName = Object.fromEntries(
              turns.map((turn) => [turn.span.name, turn]),
            );
            expect(turns).toHaveLength(4);
            expect(new Set(turns.map((turn) => turn.span.rootId)).size).toBe(4);

            for (const turn of turns) {
              expect(turn.span.type).toBe("task");
              expect(turn.span.parentIds).toEqual([]);
              expect(turn.metadata).toMatchObject({
                harnessId: "codex",
                permissionMode: "allow-all",
                scenario: "ai-sdk-harness-instrumentation",
                sessionId: "shared-harness-session",
                testRunId: harness.testRunId,
              });
              expect(turn.input).not.toHaveProperty("session");
            }
            expect(turnsByName["HarnessAgent.generate"]?.input).toEqual({
              prompt:
                'Run the built-in bash command "touch /workspace/generate-started; sleep 5; printf GENERATE_OK" exactly once. After it finishes, reply exactly GENERATE_OK.',
            });
            expect(turnsByName["HarnessAgent.stream"]?.input).toEqual({
              messages: [
                {
                  role: "user",
                  content:
                    'Run the built-in bash command "touch /workspace/stream-started; sleep 5; printf STREAM_OK" exactly once. After it finishes, reply exactly STREAM_OK.',
                },
              ],
            });
            expect(turnsByName["HarnessAgent.continueGenerate"]?.input).toEqual(
              { toolApprovalContinuations: [] },
            );
            expect(turnsByName["HarnessAgent.continueStream"]?.input).toEqual({
              toolApprovalContinuations: [],
            });
            expect(turns.some((turn) => (turn.metrics?.tokens ?? 0) > 0)).toBe(
              true,
            );

            expect(findAllSpans(events, "HarnessAgent.createSession")).toEqual(
              [],
            );
            expect(findAllSpans(events, "doGenerate").length).toBeGreaterThan(
              0,
            );
            expect(findAllSpans(events, "bash").length).toBeGreaterThan(0);

            // Suspension can attach the bash tool span to either side of the
            // continued turn. Its presence is asserted above; omit its
            // placement from the stable tree contract.
            const snapshotEvents = events.filter(
              (event) => event.span.name !== "bash",
            );
            await matchSpanTreeSnapshot(
              snapshotEvents,
              resolveFileSnapshotPath(
                import.meta.url,
                `${scenario.variantKey}-${mode}.span-tree.json`,
              ),
              {
                normalize: {
                  // Codex may include its tool call in either side of the
                  // suspended turn. Assert the exact turn inputs and tool
                  // lifecycle above, while snapshotting the stable trace
                  // shape and aggregate usage.
                  omittedKeys: [
                    "callId",
                    "content",
                    "responseMessages",
                    "steps",
                    "text",
                    "toolCalls",
                    "toolResults",
                  ],
                },
              },
            );
          });
        });
      }
    });
  }
});
