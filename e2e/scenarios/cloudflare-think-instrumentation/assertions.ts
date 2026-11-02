import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";

type ScenarioRunner = (harness: {
  runScenarioDir: (options: {
    entry?: string;
    env?: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

export function defineCloudflareThinkAssertions(options: {
  name: string;
  runScenario: ScenarioRunner;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
  usesV7Telemetry: boolean;
}): void {
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );

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

    test(
      "captures the spec-compliant Think agent tree",
      { timeout: timeoutMs },
      () => {
        expect(setupError).toBeUndefined();
        const task = findLatestSpan(events, "Think.runTurn");
        const modelSpans = findChildSpans(events, "doStream", task?.span.id);
        const toolSpans = findChildSpans(
          events,
          "lookup_weather",
          task?.span.id,
        );

        expect(task?.span.type).toBe("task");
        expect(task?.input).toEqual(
          expect.arrayContaining([expect.objectContaining({ role: "user" })]),
        );
        expect(JSON.stringify(task?.output)).toContain(
          "Vienna is sunny and 21°C.",
        );
        expect(task?.row.metadata).toMatchObject({
          braintrust: {
            integration_name: "cloudflare-think",
            sdk_language: "typescript",
          },
          model: "gpt-5-nano",
          provider: "openai.chat",
        });
        expectPositiveTokenMetrics(task?.metrics);

        expect(modelSpans).toHaveLength(2);
        for (const span of modelSpans) {
          expect(span.span.type).toBe("llm");
          expect(span.span.parentIds).toEqual([task?.span.id]);
          expect(span.input).toEqual(
            expect.objectContaining(
              options.usesV7Telemetry
                ? { messages: expect.any(Array) }
                : { prompt: expect.any(Array) },
            ),
          );
          expect(span.output).toEqual(
            expect.objectContaining(
              options.usesV7Telemetry
                ? {
                    finishReason: expect.any(String),
                    content: expect.any(Array),
                  }
                : {
                    finishReason: expect.any(Object),
                    toolCalls: expect.any(Array),
                  },
            ),
          );
          expect(span.row.metadata).toMatchObject({
            model: "gpt-5-nano",
            provider: "openai.chat",
          });
          expectPositiveTokenMetrics(span.metrics);
        }
        expect(task?.metrics?.prompt_tokens).toBe(
          modelSpans.reduce(
            (total, span) => total + (span.metrics?.prompt_tokens ?? 0),
            0,
          ),
        );
        expect(task?.metrics?.completion_tokens).toBe(
          modelSpans.reduce(
            (total, span) => total + (span.metrics?.completion_tokens ?? 0),
            0,
          ),
        );
        expect(toolSpans).toHaveLength(1);
        expect(toolSpans[0]?.span.type).toBe("tool");
        expect(toolSpans[0]?.input).toEqual({ city: "Vienna" });
        expect(toolSpans[0]?.output).toEqual({
          city: "Vienna",
          condition: "sunny",
          degreesC: 21,
        });
        expect(toolSpans[0]?.span.parentIds).toEqual([task?.span.id]);
        expect(findLatestSpan(events, "streamText")).toBeUndefined();
      },
    );

    test("matches the span tree snapshot", { timeout: timeoutMs }, async () => {
      expect(setupError).toBeUndefined();
      const names = new Set(["Think.runTurn", "doStream", "lookup_weather"]);
      const latestBySpanId = new Map<string, CapturedLogEvent>();
      for (const event of events) {
        if (event.span.id && event.span.name && names.has(event.span.name)) {
          latestBySpanId.set(event.span.id, event);
        }
      }
      await matchSpanTreeSnapshot(
        [...latestBySpanId.values()].map((event) => ({
          event,
          fields: { ...spanTreeFields(event), context: event.row.context },
        })),
        snapshotPath,
      );
    });
  });
}

function expectPositiveTokenMetrics(
  metrics: CapturedLogEvent["metrics"] | undefined,
): void {
  expect(metrics?.prompt_tokens).toBeGreaterThan(0);
  expect(metrics?.completion_tokens).toBeGreaterThan(0);
  expect(metrics?.tokens).toBe(
    (metrics?.prompt_tokens ?? 0) + (metrics?.completion_tokens ?? 0),
  );
}
