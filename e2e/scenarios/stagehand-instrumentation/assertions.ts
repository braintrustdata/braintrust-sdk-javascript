import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";
import { findAllSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  ADD_TO_CART_INSTRUCTION,
  MODEL_NAME,
  ROOT_NAME,
  SCENARIO_NAME,
  SECRET,
} from "./scenario.impl.mjs";

type RunScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const INCLUDED_NAMES = new Set([
  ROOT_NAME,
  "stagehand-act-operation",
  "stagehand-extract-operation",
  "stagehand-observe-operation",
  "stagehand-agent-operation",
  "stagehand-error-operation",
  "stagehand.act",
  "stagehand.extract",
  "stagehand.observe",
  "stagehand.agent.execute",
  "generateObject",
]);

function summarize(events: CapturedLogEvent[]): SpanTreeEntry[] {
  return [...INCLUDED_NAMES]
    .flatMap((name) => findAllSpans(events, name))
    .map((event) => ({ event, fields: spanTreeFields(event) }));
}

export function defineStagehandInstrumentationAssertions(options: {
  name: string;
  runScenario: RunScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const testConfig = { timeout: timeoutMs };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];
    let setupError: string | undefined;

    beforeAll(async () => {
      try {
        await withScenarioHarness(async (harness) => {
          await options.runScenario(harness);
          events = harness.events();
        });
      } catch (error) {
        setupError = error instanceof Error ? error.message : String(error);
      }
    }, timeoutMs);

    test("captures the bounded Stagehand contract", testConfig, () => {
      expect(setupError).toBeUndefined();
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });

      const stagehandSpans = [
        "stagehand.act",
        "stagehand.extract",
        "stagehand.observe",
        "stagehand.agent.execute",
      ].flatMap((name) => findAllSpans(events, name));
      expect(stagehandSpans.map((event) => event.span.name).sort()).toEqual([
        "stagehand.act",
        "stagehand.act",
        "stagehand.agent.execute",
        "stagehand.extract",
        "stagehand.extract",
        "stagehand.observe",
      ]);
      expect(stagehandSpans.every((event) => event.span.type === "task")).toBe(
        true,
      );
      expect(stagehandSpans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            input: { instruction: ADD_TO_CART_INSTRUCTION },
            output: {
              action_count: 1,
              methods: ["click"],
              success: true,
            },
          }),
          expect.objectContaining({
            input: expect.objectContaining({
              instruction: "Extract the cart item, quantity, and total",
            }),
            output: {
              item: "Trail Backpack",
              quantity: 1,
              total: "$129.00",
            },
          }),
          expect.objectContaining({
            input: { instruction: "Find the checkout button" },
            output: { action_count: 1, methods: ["click"] },
          }),
          expect.objectContaining({
            input: {
              instruction:
                "Review the cart and prepare to check out. Stop before submitting payment.",
            },
            output: expect.objectContaining({
              completed: true,
              output: { checkoutReady: true, itemCount: 1 },
              success: true,
            }),
          }),
        ]),
      );

      const rawExtract = stagehandSpans.find(
        (event) =>
          event.span.name === "stagehand.extract" && event.output === undefined,
      );
      expect(rawExtract?.output).toBeUndefined();
      const failedCoupon = stagehandSpans.find(
        (event) =>
          event.span.name === "stagehand.act" &&
          event.input &&
          typeof event.input === "object" &&
          "instruction" in event.input &&
          event.input.instruction === "Apply the expired coupon code",
      );
      expect(failedCoupon?.row.error).toBe("STAGEHAND_COUPON_NOT_FOUND");
      expect(JSON.stringify(stagehandSpans)).not.toContain(SECRET);

      const agent = stagehandSpans.find(
        (event) => event.span.name === "stagehand.agent.execute",
      );
      expect(agent?.metrics).toMatchObject({
        completion_reasoning_tokens: 2,
        completion_tokens: 5,
        prompt_cached_tokens: 3,
        prompt_tokens: 11,
        tokens: 16,
      });
      expect(agent?.row.metadata).toMatchObject({
        model: `openai/${MODEL_NAME}`,
        "stagehand.cache_status": "hit",
        "stagehand.max_steps": 6,
        "stagehand.mode": "dom",
        "stagehand.streaming": false,
      });
      expect(agent?.metrics).not.toHaveProperty("inference_time_ms");

      const modelSpan = findAllSpans(events, "generateObject")[0];
      expect(modelSpan).toMatchObject({
        input: { model: { modelId: MODEL_NAME } },
      });
      const modelParent = stagehandSpans.find(
        (event) =>
          event.span.name === "stagehand.act" &&
          modelSpan?.span.parentIds.includes(event.span.id ?? ""),
      );
      expect(modelParent?.input).toEqual({
        instruction: ADD_TO_CART_INSTRUCTION,
      });
    });

    test("matches the span tree", testConfig, async () => {
      expect(setupError).toBeUndefined();
      await matchSpanTreeSnapshot(summarize(events), snapshotPath);
    });
  });
}
