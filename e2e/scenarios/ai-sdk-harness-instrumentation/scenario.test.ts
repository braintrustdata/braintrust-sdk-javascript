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
            expect(turns).toHaveLength(4);
            expect(new Set(turns.map((turn) => turn.span.rootId)).size).toBe(4);

            for (const turn of turns) {
              expect(turn.span.type).toBe("task");
              expect(turn.span.parentIds).toEqual([]);
              expect(turn.metadata).toMatchObject({
                harnessId: "codex",
                permissionMode: "allow-all",
                sessionId: "shared-harness-session",
              });
              expect(turn.input).not.toHaveProperty("session");
            }
            expect(turns.some((turn) => (turn.metrics?.tokens ?? 0) > 0)).toBe(
              true,
            );

            expect(findAllSpans(events, "HarnessAgent.createSession")).toEqual(
              [],
            );
            if (mode === "auto-hook") {
              expect(findAllSpans(events, "doGenerate").length).toBeGreaterThan(
                0,
              );
              expect(findAllSpans(events, "bash").length).toBeGreaterThan(0);
            }

            await matchSpanTreeSnapshot(
              events,
              resolveFileSnapshotPath(
                import.meta.url,
                `${scenario.variantKey}-${mode}.span-tree.json`,
              ),
              { normalize: { omittedKeys: ["callId"] } },
            );
          });
        });
      }
    });
  }
});
