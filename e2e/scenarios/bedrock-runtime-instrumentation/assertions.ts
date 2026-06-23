import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  CACHE_PROMPT_MARKER,
  MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

type RunBedrockRuntimeScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const OPERATION_TO_SPAN_NAME = {
  "bedrock-converse-operation": "bedrock.converse",
  "bedrock-converse-stream-operation": "bedrock.converseStream",
  "bedrock-invoke-model-operation": "bedrock.invokeModel",
  "bedrock-invoke-model-stream-operation":
    "bedrock.invokeModelWithResponseStream",
};

function findBedrockSpan(
  events: CapturedLogEvent[],
  operationName: keyof typeof OPERATION_TO_SPAN_NAME,
) {
  const operation = findLatestSpan(events, operationName);
  const spans = findChildSpans(
    events,
    OPERATION_TO_SPAN_NAME[operationName],
    operation?.span.id,
  );
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function spanTreeEvents(
  events: CapturedLogEvent[],
): Array<CapturedLogEvent | SpanTreeEntry> {
  const root = findLatestSpan(events, ROOT_NAME);
  const items: Array<CapturedLogEvent | SpanTreeEntry> = root ? [root] : [];

  for (const operationName of Object.keys(OPERATION_TO_SPAN_NAME) as Array<
    keyof typeof OPERATION_TO_SPAN_NAME
  >) {
    const operation = findLatestSpan(events, operationName);
    const span = findBedrockSpan(events, operationName);
    if (operation) {
      items.push(operation);
    }
    if (span) {
      items.push(snapshotBedrockSpan(span));
    }
  }

  return items;
}

function snapshotBedrockSpan(event: CapturedLogEvent): SpanTreeEntry {
  return {
    event,
    fields: {
      ...spanTreeFields(event),
      input: normalizeBedrockCachePrompt(event.input),
    },
  };
}

function normalizeBedrockCachePrompt(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes(CACHE_PROMPT_MARKER)
      ? "<bedrock-cacheable-context>"
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBedrockCachePrompt(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeBedrockCachePrompt(entry),
      ]),
    );
  }

  return value;
}

export function defineBedrockRuntimeInstrumentationAssertions(options: {
  name: string;
  runScenario: RunBedrockRuntimeScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const testConfig = {
    timeout: options.timeoutMs,
  };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, options.timeoutMs);

    test("captures the scenario root span", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test("captures Bedrock Runtime command spans", testConfig, () => {
      for (const operationName of Object.keys(OPERATION_TO_SPAN_NAME) as Array<
        keyof typeof OPERATION_TO_SPAN_NAME
      >) {
        const span = findBedrockSpan(events, operationName);
        expect(span, operationName).toBeDefined();
        expect(span?.row.metadata).toMatchObject({
          model: MODEL,
          provider: "aws-bedrock",
        });
        expect(span?.output).toBeDefined();
      }
    });

    test("captures token metrics for Converse calls", testConfig, () => {
      const converseSpan = findBedrockSpan(
        events,
        "bedrock-converse-operation",
      );
      const streamSpan = findBedrockSpan(
        events,
        "bedrock-converse-stream-operation",
      );

      expect(converseSpan?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
        tokens: expect.any(Number),
      });
      expect(streamSpan?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
        time_to_first_token: expect.any(Number),
        tokens: expect.any(Number),
      });
    });

    test("captures Bedrock prompt cache metrics", testConfig, () => {
      const metrics = Object.keys(OPERATION_TO_SPAN_NAME)
        .map((operationName) =>
          findBedrockSpan(
            events,
            operationName as keyof typeof OPERATION_TO_SPAN_NAME,
          ),
        )
        .map((span) => span?.metrics)
        .filter((value): value is Record<string, unknown> => Boolean(value));

      expect(
        metrics.some(
          (metric) =>
            (typeof metric.prompt_cache_creation_tokens === "number" &&
              metric.prompt_cache_creation_tokens > 0) ||
            (typeof metric.prompt_cached_tokens === "number" &&
              metric.prompt_cached_tokens > 0),
        ),
      ).toBe(true);
    });

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(spanTreeEvents(events), spanSnapshotPath);
    });
  });
}
