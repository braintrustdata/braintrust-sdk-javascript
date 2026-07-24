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
  type SpanTreeFields,
} from "../../helpers/span-tree";
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
          fields: stableThinkSpanFields(event),
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

function stableThinkSpanFields(event: CapturedLogEvent): SpanTreeFields {
  const metadata = event.metadata;
  const metrics = event.metrics;
  const isTask = event.span.name === "Think.runTurn";

  return {
    input: isTask
      ? taskUserInput(event.input)
      : event.span.type === "tool"
        ? event.input
        : undefined,
    output: isTask || event.span.type === "tool" ? event.output : undefined,
    metadata: metadata
      ? {
          braintrust: isTask ? metadata.braintrust : undefined,
          model: metadata.model,
          provider: metadata.provider,
        }
      : undefined,
    metrics: metrics
      ? {
          completion_tokens: metrics.completion_tokens,
          prompt_tokens: metrics.prompt_tokens,
          tokens: metrics.tokens,
        }
      : undefined,
  };
}

function taskUserInput(input: unknown): unknown {
  return Array.isArray(input)
    ? input.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "user",
      )
    : input;
}
