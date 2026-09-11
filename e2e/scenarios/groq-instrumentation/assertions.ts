import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { REASONING_MODEL, ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunGroqScenario = (harness: {
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

function findGroqSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  spanName: string,
) {
  const spans = findChildSpans(events, spanName, parentId);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function batchPrompt(span: CapturedLogEvent): string {
  const firstMessage = Array.isArray(span.input) ? span.input[0] : undefined;
  return typeof firstMessage?.content === "string" ? firstMessage.content : "";
}

function findBatchTrace(events: CapturedLogEvent[], operationName: string) {
  const operation = findLatestSpan(events, operationName);
  const task = findChildSpans(events, "groq.batch", operation?.span.id)[0];
  const children = findChildSpans(
    events,
    "groq.chat.completions.create",
    task?.span.id,
  ).sort((left, right) => batchPrompt(left).localeCompare(batchPrompt(right)));
  return { operation, task, children };
}

function spanTreeEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const chatOperation = findLatestSpan(events, "groq-chat-operation");
  const streamOperation = findLatestSpan(events, "groq-stream-operation");
  const reasoningStreamOperation = findLatestSpan(
    events,
    "groq-reasoning-stream-operation",
  );
  const toolOperation = findLatestSpan(events, "groq-tool-operation");
  const batchTrace = findBatchTrace(events, "groq-batch-operation");
  const collectOnlyBatchTrace = findBatchTrace(
    events,
    "groq-batch-collect-only-operation",
  );
  const failedBatchTrace = findBatchTrace(
    events,
    "groq-batch-submission-failure-operation",
  );

  return [
    findLatestSpan(events, ROOT_NAME),
    chatOperation,
    findGroqSpan(
      events,
      chatOperation?.span.id,
      "groq.chat.completions.create",
    ),
    streamOperation,
    findGroqSpan(
      events,
      streamOperation?.span.id,
      "groq.chat.completions.create",
    ),
    reasoningStreamOperation,
    findGroqSpan(
      events,
      reasoningStreamOperation?.span.id,
      "groq.chat.completions.create",
    ),
    toolOperation,
    findGroqSpan(
      events,
      toolOperation?.span.id,
      "groq.chat.completions.create",
    ),
    batchTrace.operation,
    batchTrace.task,
    ...batchTrace.children,
    collectOnlyBatchTrace.operation,
    collectOnlyBatchTrace.task,
    ...collectOnlyBatchTrace.children,
    failedBatchTrace.operation,
    failedBatchTrace.task,
    ...failedBatchTrace.children,
  ].map((event) => event!);
}

export function defineGroqInstrumentationAssertions(options: {
  name: string;
  runScenario: RunGroqScenario;
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

    test("captures chat and stream spans", testConfig, () => {
      const chatOperation = findLatestSpan(events, "groq-chat-operation");
      const chatSpan = findGroqSpan(
        events,
        chatOperation?.span.id,
        "groq.chat.completions.create",
      );
      const streamOperation = findLatestSpan(events, "groq-stream-operation");
      const streamSpan = findGroqSpan(
        events,
        streamOperation?.span.id,
        "groq.chat.completions.create",
      );

      expect(chatSpan?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(chatSpan?.row.metadata?.model).toBeDefined();
      expect(chatSpan?.output).toBeDefined();

      expect(streamSpan?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(streamSpan?.row.metadata?.model).toBeDefined();
      expect(streamSpan?.output).toBeDefined();
      expect(streamSpan?.metrics).toMatchObject({
        time_to_first_token: expect.any(Number),
      });
    });

    test(
      "captures reasoning content from parsed streaming chunks",
      testConfig,
      () => {
        const operation = findLatestSpan(
          events,
          "groq-reasoning-stream-operation",
        );
        const span = findGroqSpan(
          events,
          operation?.span.id,
          "groq.chat.completions.create",
        );
        const reasoning = span?.output?.[0]?.message?.reasoning;

        expect(span?.row.metadata).toMatchObject({
          model: REASONING_MODEL,
          provider: "groq",
          reasoning_format: "parsed",
        });
        expect(span?.metrics).toMatchObject({
          time_to_first_token: expect.any(Number),
        });
        expect(reasoning).toEqual(expect.any(String));
        expect(reasoning?.length).toBeGreaterThan(0);
      },
    );

    test("captures tool calling span", testConfig, () => {
      const operation = findLatestSpan(events, "groq-tool-operation");
      const span = findGroqSpan(
        events,
        operation?.span.id,
        "groq.chat.completions.create",
      );

      expect(span?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(span?.row.metadata?.model).toBeDefined();
      expect(span?.output?.[0]?.message?.tool_calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({
              name: "get_weather",
            }),
          }),
        ]),
      );
    });

    test(
      "captures resumable Groq Batch task and child spans",
      testConfig,
      () => {
        const { operation, task, children } = findBatchTrace(
          events,
          "groq-batch-operation",
        );

        expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
        expect(task?.row.span_attributes?.type).toBe("task");
        expect(task?.row.metadata).toMatchObject({ provider: "groq" });
        expect(task?.input).toBeUndefined();
        expect(task?.output).toBeUndefined();
        expect(children).toHaveLength(3);
        expect(children.map(batchPrompt)).toEqual([
          "Reply with ALPHA.",
          "Reply with BRAVO.",
          "This request should fail.",
        ]);

        for (const child of children) {
          expect(child.span.parentIds).toEqual([task?.span.id ?? ""]);
          expect(child.row.metadata).toMatchObject({
            model: expect.any(String),
            provider: "groq",
          });
          expect(child.metrics?.time_to_first_token).toBeUndefined();
        }
        expect(children[0]?.output?.[0]?.message?.content).toBe("ALPHA");
        expect(children[1]?.output?.[0]?.message?.content).toBe("BRAVO");
        expect(children[0]?.metrics).toMatchObject({
          completion_tokens: 1,
          prompt_cached_tokens: 3,
          prompt_tokens: 5,
          tokens: 6,
        });
        expect(children[2]?.row.error).toContain(
          "Groq batch fixture request failed",
        );
      },
    );

    test(
      "closes pending spans after batch submission failure",
      testConfig,
      () => {
        const { operation, task, children } = findBatchTrace(
          events,
          "groq-batch-submission-failure-operation",
        );

        expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
        expect(task?.row.error).toContain("Groq batch submission failed");
        expect(children).toHaveLength(2);
        expect(children.map(batchPrompt)).toEqual([
          "First pending request.",
          "Second pending request.",
        ]);
        for (const child of children) {
          expect(child.span.parentIds).toEqual([task?.span.id ?? ""]);
          expect(child.row.error).toContain("Groq batch submission failed");
          expect(child.metrics?.end).toEqual(expect.any(Number));
        }
      },
    );

    test("captures collect-only Groq Batch spans", testConfig, () => {
      const { operation, task, children } = findBatchTrace(
        events,
        "groq-batch-collect-only-operation",
      );

      expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
      expect(operation?.span.rootId).toEqual(expect.any(String));
      expect(task?.span.rootId).toBe(operation?.span.rootId);
      expect(task?.metrics?.end).toEqual(expect.any(Number));
      expect(children).toHaveLength(1);
      expect(children[0]?.input).toEqual([
        { role: "user", content: "Collect this response." },
      ]);
      expect(children[0]?.output?.[0]?.message?.content).toBe("COLLECTED");
      expect(children[0]?.metrics).toMatchObject({
        completion_tokens: 1,
        prompt_tokens: 4,
        tokens: 5,
      });
    });

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath);
    });
  });
}
