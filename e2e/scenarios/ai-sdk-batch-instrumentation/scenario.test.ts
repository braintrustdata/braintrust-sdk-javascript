import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { findAllSpans } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const recording = ["record", "record-missing"].includes(
  process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "",
);
const timeoutMs = recording ? 22 * 60 * 1000 : 120_000;

describe("AI SDK batch instrumentation", { concurrent: false }, () => {
  for (const variantKey of ["ai-sdk-v7", "ai-sdk-v7-latest"]) {
    for (const mode of ["manual", "manual-with-auto"]) {
      test(
        `${variantKey} ${mode} across processes`,
        { timeout: timeoutMs },
        async () => {
          await withScenarioHarness(
            async (harness) => {
              const handoffPath = join(
                scenarioDir,
                `batch-${harness.testRunId}.json`,
              );
              const env = {
                AI_SDK_PACKAGE_NAME: variantKey,
                AI_SDK_BATCH_MODE: mode,
                AI_SDK_BATCH_HANDOFF_PATH: handoffPath,
              };
              const options = {
                entry: "scenario.mjs",
                scenarioDir,
                timeoutMs,
                nodeArgs:
                  mode === "manual-with-auto"
                    ? ["--import", "braintrust/hook.mjs"]
                    : [],
                runContext: {
                  variantKey,
                  originalScenarioDir,
                },
              };
              try {
                await harness.runNodeScenarioDir({
                  ...options,
                  runContext: {
                    ...options.runContext,
                    cassette: { variantKey: `${variantKey}-${mode}-submit` },
                  },
                  env: { ...env, AI_SDK_BATCH_PHASE: "submit" },
                });
                const { context } = JSON.parse(
                  await readFile(handoffPath, "utf8"),
                ) as { context: string };
                expect(context).not.toContain("Reply with only");
                expect(context).not.toContain("webhookSigningSecret");
                const pending = findAllSpans(harness.events(), "ai.batch");
                expect(pending).toHaveLength(1);
                expect(pending[0].metrics?.end).toBeUndefined();
                const initialIds = findAllSpans(
                  harness.events(),
                  "ai.batch.request",
                )
                  .map((event) => event.span.id)
                  .sort();
                expect(initialIds).toHaveLength(2);
                await harness.runNodeScenarioDir({
                  ...options,
                  runContext: {
                    ...options.runContext,
                    cassette: { variantKey: `${variantKey}-${mode}-complete` },
                  },
                  env: { ...env, AI_SDK_BATCH_PHASE: "complete" },
                });
                const events = harness.events();
                const task = findAllSpans(events, "ai.batch");
                const children = findAllSpans(events, "ai.batch.request");
                expect(task).toHaveLength(1);
                expect(children.map((event) => event.span.id).sort()).toEqual(
                  initialIds,
                );
                expect(task[0].metrics?.end).toEqual(expect.any(Number));
                for (const child of children) {
                  expect(child.span.parentIds).toEqual([task[0].span.id]);
                  expect(child.input).toBeDefined();
                  expect(child.output).toBeDefined();
                  expect(child.metrics?.tokens).toBeGreaterThan(0);
                  expect(child.metrics?.end).toEqual(expect.any(Number));
                }
                await matchSpanTreeSnapshot(
                  events.map((event) => ({
                    event,
                    fields: {
                      ...spanTreeFields(event),
                      context: event.row.context,
                    },
                  })),
                  resolveFileSnapshotPath(
                    import.meta.url,
                    `${variantKey}-${mode}.span-tree.json`,
                  ),
                  { normalize: { additionalProviderIdKeys: ["batch_id"] } },
                );
              } finally {
                await rm(handoffPath, { force: true });
              }
            },
            { isolateProductionLogIds: true },
          );
        },
      );
    }
  }
});
