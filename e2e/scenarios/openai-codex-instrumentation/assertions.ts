import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
  type SpanTreeFields,
} from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunOpenAICodexScenario = (harness: {
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

const OPERATION_NAMES = [
  "openai-codex-run-operation",
  "openai-codex-run-streamed-operation",
] as const;

const EXPECTED_MARKERS = {
  "openai-codex-run-operation": "OPENAI_CODEX_RUN_OK",
  "openai-codex-run-streamed-operation": "OPENAI_CODEX_STREAM_OK",
} as const;

const METADATA_KEYS = [
  "provider",
  "model",
  "operation",
  "scenario",
  "gen_ai.tool.name",
  "openai_codex.llm_sequence",
  "openai_codex.operation",
  "openai_codex.model",
  "openai_codex.thread_id",
  "openai_codex.item_type",
  "openai_codex.command.status",
  "openai_codex.mcp.server",
  "openai_codex.mcp.status",
] as const;

function findCodexTask(events: CapturedLogEvent[], operationName: string) {
  const operation = findLatestSpan(events, operationName);
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.span.name === "OpenAI Codex" &&
        event.span.parentIds.includes(operation?.span.id ?? ""),
    );
}

function latestSpansByType(
  events: CapturedLogEvent[],
  type: string,
): CapturedLogEvent[] {
  const order: string[] = [];
  const latest = new Map<string, CapturedLogEvent>();

  for (const event of events) {
    if (event.span.type !== type || !event.span.id) {
      continue;
    }
    if (!latest.has(event.span.id)) {
      order.push(event.span.id);
    }
    if (shouldPreferSpanUpdate(latest.get(event.span.id), event)) {
      latest.set(event.span.id, event);
    }
  }

  return order.flatMap((spanId) => {
    const event = latest.get(spanId);
    return event ? [event] : [];
  });
}

function latestSpansForParent(
  events: CapturedLogEvent[],
  parentSpanId: string | undefined,
): CapturedLogEvent[] {
  if (!parentSpanId) {
    return [];
  }

  const order: string[] = [];
  const latest = new Map<string, CapturedLogEvent>();

  for (const event of events) {
    if (!event.span.id || !event.span.parentIds.includes(parentSpanId)) {
      continue;
    }
    if (!latest.has(event.span.id)) {
      order.push(event.span.id);
    }
    if (shouldPreferSpanUpdate(latest.get(event.span.id), event)) {
      latest.set(event.span.id, event);
    }
  }

  return order.flatMap((spanId) => {
    const event = latest.get(spanId);
    return event ? [event] : [];
  });
}

function shouldPreferSpanUpdate(
  previous: CapturedLogEvent | undefined,
  next: CapturedLogEvent,
): boolean {
  if (!previous) {
    return true;
  }
  if (next.span.ended && !previous.span.ended) {
    return true;
  }
  if (previous.span.ended && !next.span.ended) {
    return false;
  }
  return true;
}

function expectPositiveMetric(
  event: CapturedLogEvent | undefined,
  keys: string[],
): void {
  const hasPositiveMetric = keys.some((key) => {
    const value = event?.metrics?.[key];
    return typeof value === "number" && value > 0;
  });

  expect(hasPositiveMetric).toBe(true);
}

function outputText(event: CapturedLogEvent | undefined): string {
  return typeof event?.output === "string"
    ? event.output
    : JSON.stringify(event?.output ?? "");
}

function sequenceNumber(event: CapturedLogEvent): number | undefined {
  const value = event.metadata?.["openai_codex.llm_sequence"];
  return typeof value === "number" ? value : undefined;
}

function snapshotFields(event: CapturedLogEvent): SpanTreeFields {
  const fields = spanTreeFields(event);
  const metadata =
    fields.metadata &&
    typeof fields.metadata === "object" &&
    !Array.isArray(fields.metadata)
      ? Object.fromEntries(
          Object.entries(fields.metadata).filter(([key]) =>
            METADATA_KEYS.includes(key as (typeof METADATA_KEYS)[number]),
          ),
        )
      : undefined;

  if (metadata && typeof metadata["openai_codex.thread_id"] === "string") {
    metadata["openai_codex.thread_id"] = "<thread-id>";
  }

  return {
    ...fields,
    metadata,
    ...(event.span.type === "llm"
      ? { output: summarizeLlmOutput(event.output) }
      : {}),
  };
}

function summarizeLlmOutput(output: unknown): SpanTreeFields["output"] {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return null;
  }
  const outputRecord = output as { message?: unknown; reasoning?: unknown };

  return {
    ...(typeof outputRecord.reasoning === "string"
      ? { reasoning: outputRecord.reasoning }
      : {}),
    ...(typeof outputRecord.message === "string"
      ? { message: outputRecord.message }
      : {}),
  };
}

function summarize(events: CapturedLogEvent[]): SpanTreeEntry[] {
  const runTask = findCodexTask(events, "openai-codex-run-operation");
  const streamedTask = findCodexTask(
    events,
    "openai-codex-run-streamed-operation",
  );
  const llmSpans = latestSpansByType(events, "llm");
  const toolSpans = latestSpansByType(events, "tool");

  return [
    findLatestSpan(events, ROOT_NAME),
    findLatestSpan(events, "openai-codex-run-operation"),
    runTask,
    findLatestSpan(events, "openai-codex-run-streamed-operation"),
    streamedTask,
    ...llmSpans,
    ...toolSpans,
  ].flatMap((event) =>
    event ? [{ event, fields: snapshotFields(event) }] : [],
  );
}

function spanSnapshotPath(options: {
  snapshotName: string;
  testFileUrl: string;
}): string {
  return resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
}

export function defineOpenAICodexInstrumentationAssertions(options: {
  name: string;
  runScenario: RunOpenAICodexScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
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

    test("captures the root trace", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
    });

    test("captures Codex task spans", testConfig, () => {
      for (const operationName of OPERATION_NAMES) {
        const operation = findLatestSpan(events, operationName);
        const task = findCodexTask(events, operationName);

        expect(operation).toBeDefined();
        expect(task).toBeDefined();
        expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
        expect(task?.row.metadata).toMatchObject({
          provider: "openai",
        });
        expect(task?.row.metadata?.["openai_codex.model"]).toEqual(
          expect.any(String),
        );
      }
    });

    test("captures dynamic LLM spans for each Codex turn", testConfig, () => {
      const llmSpans = latestSpansByType(events, "llm");

      expect(llmSpans.length).toBeGreaterThanOrEqual(OPERATION_NAMES.length);
      expect(
        llmSpans.every((event) => event.span.name === "OpenAI Codex LLM"),
      ).toBe(true);

      for (const operationName of OPERATION_NAMES) {
        const task = findCodexTask(events, operationName);
        const taskLlmSpans = latestSpansForParent(events, task?.span.id).filter(
          (event) => event.span.type === "llm",
        );
        const sequences = taskLlmSpans
          .map(sequenceNumber)
          .filter((value): value is number => value !== undefined);

        expect(taskLlmSpans.length).toBeGreaterThanOrEqual(1);
        expect(sequences[0]).toBe(1);
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      }
    });

    test("captures Codex web search tool spans", testConfig, () => {
      const toolSpans = latestSpansByType(events, "tool");

      expect(toolSpans.length).toBeGreaterThanOrEqual(1);
      expect(
        toolSpans.some((event) => event.span.name === "tool: web_search"),
      ).toBe(true);

      for (const operationName of OPERATION_NAMES) {
        const task = findCodexTask(events, operationName);
        const childTypes = latestSpansForParent(events, task?.span.id).map(
          (event) => event.span.type,
        );

        expect(childTypes).toContain("llm");
      }
    });

    test("captures final responses and usage metrics", testConfig, () => {
      for (const operationName of OPERATION_NAMES) {
        const task = findCodexTask(events, operationName);

        expect(outputText(task)).toContain(EXPECTED_MARKERS[operationName]);
        expectPositiveMetric(task, [
          "tokens",
          "prompt_tokens",
          "completion_tokens",
        ]);
      }
    });

    test("matches the span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath(options));
    });
  });
}
