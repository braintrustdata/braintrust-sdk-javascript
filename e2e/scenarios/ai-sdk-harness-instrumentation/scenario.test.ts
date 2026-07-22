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

function numericMetric(
  event: { metrics?: Record<string, unknown> } | undefined,
  name: string,
): number {
  const value = event?.metrics?.[name];
  expect(value, `expected numeric ${name} metric`).toEqual(expect.any(Number));
  return value as number;
}
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
            expect(new Set(turns.map((turn) => turn.span.rootId)).size).toBe(2);

            for (const turn of turns) {
              expect(turn.span.type).toBe("task");
              expect(turn.metadata).toMatchObject({
                harnessId: "codex",
                permissionMode: "allow-all",
                scenario: "ai-sdk-harness-instrumentation",
                sessionId: "shared-harness-session",
                testRunId: harness.testRunId,
              });
              expect(turn.input).not.toHaveProperty("session");
            }
            expect(
              turnsByName["HarnessAgent.generate"]?.span.parentIds,
            ).toEqual([]);
            expect(turnsByName["HarnessAgent.stream"]?.span.parentIds).toEqual(
              [],
            );
            expect(
              turnsByName["HarnessAgent.continueGenerate"]?.span.parentIds,
            ).toEqual([turnsByName["HarnessAgent.generate"]?.span.id]);
            expect(
              turnsByName["HarnessAgent.continueStream"]?.span.parentIds,
            ).toEqual([turnsByName["HarnessAgent.stream"]?.span.id]);
            for (const [initialName, continuationName] of [
              ["HarnessAgent.generate", "HarnessAgent.continueGenerate"],
              ["HarnessAgent.stream", "HarnessAgent.continueStream"],
            ] as const) {
              const initial = turnsByName[initialName];
              const continuation = turnsByName[continuationName];
              expect(numericMetric(initial, "start")).toBeLessThanOrEqual(
                numericMetric(continuation, "start"),
              );
              expect(numericMetric(continuation, "end")).toBeLessThanOrEqual(
                numericMetric(initial, "end"),
              );
              expect(initial?.output).toEqual(continuation?.output);
              for (const metric of [
                "completion_tokens",
                "prompt_tokens",
                "tokens",
              ]) {
                expect(initial?.metrics?.[metric]).toBe(
                  continuation?.metrics?.[metric],
                );
              }
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
            const bashSpans = findAllSpans(events, "bash");
            expect(bashSpans).toHaveLength(2);
            for (const bashSpan of bashSpans) {
              expect(bashSpan.span.type).toBe("tool");
              expect(bashSpan.span.parentIds).toHaveLength(1);
              expect(bashSpan.metadata).toMatchObject({
                toolName: "bash",
              });
            }

            const generateBashSpan = bashSpans.find((span) =>
              String(span.input).includes("/workspace/generate-started"),
            );
            const streamBashSpan = bashSpans.find((span) =>
              String(span.input).includes("/workspace/stream-started"),
            );
            expect(generateBashSpan?.input).toBe(
              '{"command":"/bin/bash -lc \'touch /workspace/generate-started; sleep 5; printf GENERATE_OK\'"}',
            );
            expect(streamBashSpan?.input).toBe(
              '{"command":"/bin/bash -lc \'touch /workspace/stream-started; sleep 5; printf STREAM_OK\'"}',
            );
            expect(generateBashSpan?.span.rootId).toBe(
              turnsByName["HarnessAgent.generate"]?.span.rootId,
            );
            expect(generateBashSpan?.span.parentIds).toEqual([
              turnsByName["HarnessAgent.generate"]?.span.id,
            ]);
            expect(streamBashSpan?.span.rootId).toBe(
              turnsByName["HarnessAgent.stream"]?.span.rootId,
            );
            expect(streamBashSpan?.span.parentIds).toEqual([
              turnsByName["HarnessAgent.stream"]?.span.id,
            ]);
            for (const [toolSpan, initialName] of [
              [generateBashSpan, "HarnessAgent.generate"],
              [streamBashSpan, "HarnessAgent.stream"],
            ] as const) {
              expect(
                numericMetric(turnsByName[initialName], "start"),
              ).toBeLessThanOrEqual(numericMetric(toolSpan, "start"));
              expect(numericMetric(toolSpan, "start")).toBeLessThanOrEqual(
                numericMetric(turnsByName[initialName], "end"),
              );
            }

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
                // Keep display deterministic while the focused assertions
                // above preserve the suspend/resume chronology contract.
                siblingOrder: "name",
                normalize: {
                  // These fields can be split across either side of a
                  // suspended Codex turn. The trace hierarchy and tool
                  // ownership remain stable and are snapshot-tested.
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
