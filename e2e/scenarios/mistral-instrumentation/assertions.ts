import { beforeAll, describe, expect, test } from "vitest";
import type {
  CapturedLogEvent,
  CapturedLogRow,
} from "../../helpers/mock-braintrust-server";
import type { Json } from "../../helpers/normalize";
import {
  matchFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  formatSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  ADJUSTABLE_REASONING_MODEL,
  FIM_MODEL,
  CHAT_MODEL,
  CLASSIFIER_MODEL,
  AGENT_MODEL,
  EMBEDDING_MODEL,
  NATIVE_REASONING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

type RunMistralScenario = (harness: {
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

function findMistralSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  for (const name of names) {
    const spans = findChildSpans(events, name, parentId);
    const spanWithOutput = spans.find((candidate) => candidate.output != null);
    if (spanWithOutput) {
      return spanWithOutput;
    }
    if (spans[0]) {
      return spans[0];
    }
  }

  return undefined;
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function pickMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): Json {
  if (!metadata) {
    return null;
  }

  const picked = Object.fromEntries(
    keys.flatMap((key) =>
      key in metadata ? [[key, metadata[key] as Json]] : [],
    ),
  );

  return Object.keys(picked).length > 0 ? (picked as Json) : null;
}

function summarizeInput(
  input: unknown,
  options?: { omitObjectKeys?: boolean },
): Json {
  if (Array.isArray(input)) {
    const roles = input
      .map((message) =>
        isRecord(message as Json) && typeof message.role === "string"
          ? message.role
          : null,
      )
      .filter((role): role is string => role !== null);

    return {
      item_count: input.length,
      roles,
      type: "messages",
    };
  }

  if (typeof input === "string") {
    return "<string>";
  }

  if (!isRecord(input as Json)) {
    return null;
  }

  if (options?.omitObjectKeys) {
    return {
      type: "object",
    };
  }

  return {
    keys: Object.keys(input).sort(),
    type: "object",
  };
}

function summarizeOutput(output: unknown): Json {
  if (Array.isArray(output)) {
    const firstChoice = output[0] as Json;
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
      return {
        choice_count: output.length,
        finish_reason: null,
        type: "array",
      };
    }

    const message = firstChoice.message;
    const finishReason =
      typeof firstChoice.finishReason === "string" ||
      firstChoice.finishReason === null
        ? firstChoice.finishReason
        : typeof firstChoice.finish_reason === "string" ||
            firstChoice.finish_reason === null
          ? firstChoice.finish_reason
          : null;
    const toolCalls =
      (Array.isArray(message.tool_calls) && message.tool_calls) ||
      (Array.isArray(message.toolCalls) && message.toolCalls) ||
      [];
    const contentParts = Array.isArray(message.content) ? message.content : [];
    const contentPartTypes = contentParts
      .map((part) =>
        isRecord(part) && typeof part.type === "string" ? part.type : null,
      )
      .filter((part): part is string => part !== null);
    const summary = {
      choice_count: output.length,
      finish_reason: finishReason,
      has_content:
        typeof message.content === "string"
          ? message.content.length > 0
          : contentPartTypes.includes("text")
            ? true
            : false,
      role: typeof message.role === "string" ? message.role : null,
      tool_call_count: toolCalls.length,
      type: "choices",
    };

    if (Array.isArray(message.content)) {
      const hasThinkingContent = contentPartTypes.includes("thinking");

      return {
        ...summary,
        content_part_types: contentPartTypes,
        finish_reason: hasThinkingContent ? null : finishReason,
        thinking_block_count: contentPartTypes.filter(
          (partType) => partType === "thinking",
        ).length,
        text_block_count: contentPartTypes.filter(
          (partType) => partType === "text",
        ).length,
      };
    }

    return summary;
  }

  if (!isRecord(output as Json)) {
    return output === undefined ? null : "<scalar>";
  }

  if (typeof output.embedding_length === "number") {
    return {
      embedding_length: "<number>",
      type: "embedding",
    };
  }

  return {
    keys: Object.keys(output).sort(),
    type: "object",
  };
}

function summarizePayloadRow(row: CapturedLogRow): Json {
  const metrics =
    typeof row.metrics === "object" &&
    row.metrics !== null &&
    !Array.isArray(row.metrics)
      ? (row.metrics as Record<string, unknown>)
      : {};
  return {
    has_input: row.input !== undefined && row.input !== null,
    has_output: row.output !== undefined && row.output !== null,
    input: summarizeInput(row.input),
    metadata: pickMetadata(
      row.metadata as Record<string, unknown> | undefined,
      ["model", "operation", "provider", "reasoning_effort", "scenario"],
    ),
    metric_keys: Object.keys(metrics)
      .filter((key) => key !== "start" && key !== "end")
      .sort(),
    output: summarizeOutput(row.output),
    span_id: typeof row.span_id === "string" ? row.span_id : null,
  } satisfies Json;
}

function normalizeLegacyV134MetricKeys(metricKeys: Json): Json {
  if (!Array.isArray(metricKeys)) {
    return metricKeys;
  }

  return metricKeys.includes("time_to_first_token")
    ? ["time_to_first_token"]
    : metricKeys;
}

function normalizeLegacyV134PayloadSummaryRow(
  summaryRow: Json,
  snapshotName: string,
  spanName: string | undefined,
): Json {
  const unstableLegacyV134SpanNames = new Set([
    "mistral.chat.stream",
    "mistral.fim.stream",
  ]);
  let normalizedSummaryRow = summaryRow;

  if (
    snapshotName === "mistral-v1-3-4" &&
    spanName &&
    unstableLegacyV134SpanNames.has(spanName) &&
    isRecord(summaryRow)
  ) {
    const output = isRecord(summaryRow.output) ? summaryRow.output : null;

    normalizedSummaryRow = {
      ...summaryRow,
      metric_keys: normalizeLegacyV134MetricKeys(summaryRow.metric_keys),
      ...(output
        ? {
            output: {
              ...output,
              finish_reason: null,
            },
          }
        : {}),
    };
  }

  if (!isRecord(normalizedSummaryRow)) {
    return normalizedSummaryRow;
  }

  const output = isRecord(normalizedSummaryRow.output)
    ? normalizedSummaryRow.output
    : null;
  const metadata = isRecord(normalizedSummaryRow.metadata)
    ? normalizedSummaryRow.metadata
    : null;

  if (output && metadata?.reasoning_effort === "high") {
    return {
      ...normalizedSummaryRow,
      output: {
        ...output,
        finish_reason: null,
      },
    };
  }

  return normalizedSummaryRow;
}

function pickOutputSpans<T extends { output?: unknown }>(spans: T[]): T[] {
  const spansWithOutput = spans.filter(
    (span) => span.output !== undefined && span.output !== null,
  );
  return spansWithOutput.length > 0 ? spansWithOutput : spans;
}

function snapshotEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const chatCompleteOperation = findLatestSpan(
    events,
    "mistral-chat-complete-operation",
  );
  const chatStreamOperation = findLatestSpan(
    events,
    "mistral-chat-stream-operation",
  );
  const chatReasoningStreamOperation = findLatestSpan(
    events,
    "mistral-chat-reasoning-stream-operation",
  );
  const chatThinkingStreamOperation = findLatestSpan(
    events,
    "mistral-chat-thinking-stream-operation",
  );
  const chatToolCallOperation = findLatestSpan(
    events,
    "mistral-chat-tool-call-operation",
  );
  const chatToolCallSpans = findChildSpans(
    events,
    "mistral.chat.complete",
    chatToolCallOperation?.span.id,
  );
  const selectedChatToolCallSpans = pickOutputSpans(chatToolCallSpans);
  const fimCompleteOperation = findLatestSpan(
    events,
    "mistral-fim-complete-operation",
  );
  const fimStreamOperation = findLatestSpan(
    events,
    "mistral-fim-stream-operation",
  );
  const agentsCompleteOperation = findLatestSpan(
    events,
    "mistral-agents-complete-operation",
  );
  const agentsToolCallOperation = findLatestSpan(
    events,
    "mistral-agents-tool-call-operation",
  );
  const agentsToolCallSpans = findChildSpans(
    events,
    "mistral.agents.complete",
    agentsToolCallOperation?.span.id,
  );
  const selectedAgentsToolCallSpans = pickOutputSpans(agentsToolCallSpans);
  const agentsStreamOperation = findLatestSpan(
    events,
    "mistral-agents-stream-operation",
  );
  const embeddingsOperation = findLatestSpan(
    events,
    "mistral-embeddings-operation",
  );
  const classifiersModerateOperation = findLatestSpan(
    events,
    "mistral-classifiers-moderate-operation",
  );
  const classifiersModerateChatOperation = findLatestSpan(
    events,
    "mistral-classifiers-moderate-chat-operation",
  );
  const classifiersClassifyOperation = findLatestSpan(
    events,
    "mistral-classifiers-classify-operation",
  );
  const classifiersClassifyChatOperation = findLatestSpan(
    events,
    "mistral-classifiers-classify-chat-operation",
  );

  return [
    findLatestSpan(events, ROOT_NAME),
    chatCompleteOperation,
    findMistralSpan(events, chatCompleteOperation?.span.id, [
      "mistral.chat.complete",
    ]),
    chatStreamOperation,
    findMistralSpan(events, chatStreamOperation?.span.id, [
      "mistral.chat.stream",
    ]),
    chatReasoningStreamOperation,
    findMistralSpan(events, chatReasoningStreamOperation?.span.id, [
      "mistral.chat.stream",
    ]),
    chatThinkingStreamOperation,
    findMistralSpan(events, chatThinkingStreamOperation?.span.id, [
      "mistral.chat.stream",
    ]),
    chatToolCallOperation,
    ...selectedChatToolCallSpans,
    fimCompleteOperation,
    findMistralSpan(events, fimCompleteOperation?.span.id, [
      "mistral.fim.complete",
    ]),
    fimStreamOperation,
    findMistralSpan(events, fimStreamOperation?.span.id, [
      "mistral.fim.stream",
    ]),
    agentsCompleteOperation,
    findMistralSpan(events, agentsCompleteOperation?.span.id, [
      "mistral.agents.complete",
    ]),
    agentsToolCallOperation,
    ...selectedAgentsToolCallSpans,
    agentsStreamOperation,
    findMistralSpan(events, agentsStreamOperation?.span.id, [
      "mistral.agents.stream",
    ]),
    embeddingsOperation,
    findMistralSpan(events, embeddingsOperation?.span.id, [
      "mistral.embeddings.create",
    ]),
    classifiersModerateOperation,
    findMistralSpan(events, classifiersModerateOperation?.span.id, [
      "mistral.classifiers.moderate",
    ]),
    classifiersModerateChatOperation,
    findMistralSpan(events, classifiersModerateChatOperation?.span.id, [
      "mistral.classifiers.moderateChat",
    ]),
    classifiersClassifyOperation,
    findMistralSpan(events, classifiersClassifyOperation?.span.id, [
      "mistral.classifiers.classify",
    ]),
    classifiersClassifyChatOperation,
    findMistralSpan(events, classifiersClassifyChatOperation?.span.id, [
      "mistral.classifiers.classifyChat",
    ]),
  ].filter((event): event is CapturedLogEvent => event !== undefined);
}

function buildSpanTree(
  events: CapturedLogEvent[],
  snapshotName: string,
): SpanTreeEntry[] {
  return snapshotEvents(events).map((event) => {
    const summary = normalizeLegacyV134PayloadSummaryRow(
      summarizePayloadRow(event.row),
      snapshotName,
      event.span.name,
    ) as Record<string, Json>;
    const {
      span_id: _spanId,
      has_input: _hasInput,
      has_output: _hasOutput,
      metric_keys: metricKeys,
      ...fields
    } = summary;

    return {
      event,
      fields: {
        span_attributes: spanTreeFields(event).span_attributes,
        ...fields,
        metrics: {
          keys: metricKeys,
        },
      },
    };
  });
}

export function defineMistralInstrumentationAssertions(options: {
  name: string;
  runScenario: RunMistralScenario;
  snapshotName: string;
  supportsClassifiers?: boolean;
  supportsClassify?: boolean;
  supportsThinkingStream?: boolean;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.txt`,
  );
  const supportsThinkingStream = options.supportsThinkingStream ?? true;
  const supportsClassifiers = options.supportsClassifiers ?? true;
  const classifyModel = nonEmptyString(process.env.MISTRAL_CLASSIFIER_MODEL);
  const supportsClassify =
    (options.supportsClassify ?? true) && !!classifyModel;
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const testConfig = {
    timeout: timeoutMs,
  };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, timeoutMs);

    test("captures the root trace for the scenario", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test("captures trace for chat.complete()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-chat-complete-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.chat.complete",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: CHAT_MODEL,
        provider: "mistral",
      });
      expect(span?.output).toBeDefined();
    });

    test("captures trace for chat.stream()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "mistral-chat-stream-operation");
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.chat.stream",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: CHAT_MODEL,
        provider: "mistral",
      });
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test(
      "captures trace for chat.stream() reasoning metadata",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "mistral-chat-reasoning-stream-operation",
        );
        const span = findMistralSpan(events, operation?.span.id, [
          "mistral.chat.stream",
        ]);
        const metadata = span?.row.metadata as
          | Record<string, unknown>
          | undefined;

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.span.type).toBe("llm");
        expect(metadata).toMatchObject({
          model: ADJUSTABLE_REASONING_MODEL,
          provider: "mistral",
          reasoning_effort: "high",
        });
        expect(span?.metrics).toMatchObject({
          time_to_first_token: expect.any(Number),
          ...(options.snapshotName === "mistral-v1-3-4"
            ? {}
            : {
                prompt_tokens: expect.any(Number),
                completion_tokens: expect.any(Number),
              }),
        });
        expect(span?.output).toBeDefined();
      },
    );

    if (supportsThinkingStream) {
      test(
        "captures trace for chat.stream() thinking content",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const operation = findLatestSpan(
            events,
            "mistral-chat-thinking-stream-operation",
          );
          const span = findMistralSpan(events, operation?.span.id, [
            "mistral.chat.stream",
          ]);
          const metadata = span?.row.metadata as
            | Record<string, unknown>
            | undefined;
          const output = span?.output as
            | Array<{
                message?: {
                  content?:
                    | Array<{
                        thinking?: Array<{ text?: string; type?: string }>;
                        text?: string;
                        type?: string;
                      }>
                    | string
                    | null;
                };
              }>
            | undefined;
          const content = output?.[0]?.message?.content;

          expect(operation).toBeDefined();
          expect(span).toBeDefined();
          expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
          expect(span?.span.type).toBe("llm");
          expect(metadata).toMatchObject({
            model: NATIVE_REASONING_MODEL,
            provider: "mistral",
          });
          expect(span?.metrics).toMatchObject({
            time_to_first_token: expect.any(Number),
            prompt_tokens: expect.any(Number),
            completion_tokens: expect.any(Number),
          });
          if (Array.isArray(content)) {
            expect(content.some((part) => part.type === "thinking")).toBe(true);
            expect(content.some((part) => part.type === "text")).toBe(true);
          } else {
            expect(content).toEqual(expect.any(String));
            expect(content?.length).toBeGreaterThan(0);
          }
        },
      );
    }

    test("captures trace for chat.complete() tool calling", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-chat-tool-call-operation",
      );
      const spans = findChildSpans(
        events,
        "mistral.chat.complete",
        operation?.span.id,
      );
      const selectedSpans = pickOutputSpans(spans);
      const toolCallCountBySpanId = new Map<string, number>(
        selectedSpans.map((span) => {
          const output = span.output as
            | Array<{
                message?: {
                  toolCalls?: unknown;
                  tool_calls?: unknown;
                };
              }>
            | undefined;
          const firstChoice = Array.isArray(output) ? output[0] : undefined;
          const toolCalls =
            (Array.isArray(firstChoice?.message?.tool_calls) &&
              firstChoice.message.tool_calls) ||
            (Array.isArray(firstChoice?.message?.toolCalls) &&
              firstChoice.message.toolCalls) ||
            [];
          return [span.span.id, toolCalls.length];
        }),
      );
      const spansWithToolCalls = selectedSpans.filter((span) => {
        return (toolCallCountBySpanId.get(span.span.id) || 0) > 0;
      });
      const finishReasons = selectedSpans
        .map((span) => {
          const output = span.output as
            | Array<{
                finishReason?: unknown;
                finish_reason?: unknown;
              }>
            | undefined;
          const firstChoice = Array.isArray(output) ? output[0] : undefined;
          if (typeof firstChoice?.finishReason === "string") {
            return firstChoice.finishReason;
          }
          if (typeof firstChoice?.finish_reason === "string") {
            return firstChoice.finish_reason;
          }
          return undefined;
        })
        .filter((value): value is string => typeof value === "string");
      const toolNames = new Set(
        selectedSpans.flatMap((span) => {
          const output = span.output as
            | Array<{
                message?: {
                  toolCalls?: unknown;
                  tool_calls?: unknown;
                };
              }>
            | undefined;
          const firstChoice = Array.isArray(output) ? output[0] : undefined;
          const toolCalls =
            (Array.isArray(firstChoice?.message?.tool_calls) &&
              firstChoice.message.tool_calls) ||
            (Array.isArray(firstChoice?.message?.toolCalls) &&
              firstChoice.message.toolCalls) ||
            [];

          return toolCalls
            .map((toolCall) => {
              if (
                !toolCall ||
                typeof toolCall !== "object" ||
                Array.isArray(toolCall)
              ) {
                return undefined;
              }
              const toolFunction = (
                toolCall as { function?: { name?: unknown } }
              ).function;
              return typeof toolFunction?.name === "string"
                ? toolFunction.name
                : undefined;
            })
            .filter((name): name is string => typeof name === "string");
        }),
      );

      expect(operation).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(selectedSpans.length).toBeGreaterThanOrEqual(2);
      expect(spansWithToolCalls.length).toBeGreaterThanOrEqual(2);
      expect(
        Array.from(toolCallCountBySpanId.values()).some((count) => count >= 2),
      ).toBe(true);
      expect(finishReasons.length).toBeGreaterThanOrEqual(2);

      for (const span of selectedSpans) {
        expect(span.span.type).toBe("llm");
        expect(span.row.metadata).toMatchObject({
          model: CHAT_MODEL,
          provider: "mistral",
        });
      }

      expect(toolNames.has("get_weather")).toBe(true);
      expect(toolNames.has("get_exchange_rate")).toBe(true);
    });

    test("captures trace for fim.complete()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-fim-complete-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.fim.complete",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: FIM_MODEL,
        provider: "mistral",
      });
      expect(span?.input).toEqual(expect.any(String));
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for fim.stream()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "mistral-fim-stream-operation");
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.fim.stream",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: FIM_MODEL,
        provider: "mistral",
      });
      expect(span?.input).toEqual(expect.any(String));
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for agents.complete()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-agents-complete-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.agents.complete",
      ]);
      const metadata = span?.row.metadata as
        | Record<string, unknown>
        | undefined;
      const input = span?.input as Array<{ role?: string }> | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(metadata).toMatchObject({
        provider: "mistral",
        agentId: expect.any(String),
      });
      if (typeof metadata?.model === "string") {
        expect(metadata.model).toBe(AGENT_MODEL);
      }
      expect(input).toEqual(expect.any(Array));
      expect(input?.[0]?.role).toBe("user");
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test(
      "captures trace for agents.complete() tool calling",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "mistral-agents-tool-call-operation",
        );
        const spans = findChildSpans(
          events,
          "mistral.agents.complete",
          operation?.span.id,
        );
        const selectedSpans = pickOutputSpans(spans);
        const spansWithToolCalls = selectedSpans.filter((span) => {
          const output = span.output as
            | Array<{
                message?: {
                  toolCalls?: unknown;
                  tool_calls?: unknown;
                };
              }>
            | undefined;
          const firstChoice = Array.isArray(output) ? output[0] : undefined;
          const toolCalls =
            (Array.isArray(firstChoice?.message?.tool_calls) &&
              firstChoice.message.tool_calls) ||
            (Array.isArray(firstChoice?.message?.toolCalls) &&
              firstChoice.message.toolCalls) ||
            [];
          return toolCalls.length > 0;
        });

        expect(operation).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(selectedSpans.length).toBeGreaterThanOrEqual(1);
        expect(spansWithToolCalls.length).toBeGreaterThanOrEqual(1);

        for (const span of selectedSpans) {
          expect(span.span.type).toBe("llm");
          expect(span.row.metadata).toMatchObject({
            provider: "mistral",
          });
        }
      },
    );

    test("captures trace for agents.stream()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "mistral-agents-stream-operation",
      );
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.agents.stream",
      ]);
      const metadata = span?.row.metadata as
        | Record<string, unknown>
        | undefined;
      const input = span?.input as Array<{ role?: string }> | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(metadata).toMatchObject({
        provider: "mistral",
        agentId: expect.any(String),
      });
      if (typeof metadata?.model === "string") {
        expect(metadata.model).toBe(AGENT_MODEL);
      }
      expect(input).toEqual(expect.any(Array));
      expect(input?.[0]?.role).toBe("user");
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test("captures trace for embeddings.create()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "mistral-embeddings-operation");
      const span = findMistralSpan(events, operation?.span.id, [
        "mistral.embeddings.create",
      ]);
      const output = span?.output as { embedding_length?: number } | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        model: EMBEDDING_MODEL,
        provider: "mistral",
      });
      expect(output?.embedding_length).toEqual(expect.any(Number));
      expect(output?.embedding_length).toBeGreaterThan(0);
    });

    if (supportsClassifiers) {
      test("captures trace for classifiers.moderate()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "mistral-classifiers-moderate-operation",
        );
        const span = findMistralSpan(events, operation?.span.id, [
          "mistral.classifiers.moderate",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.span.type).toBe("llm");
        expect(span?.row.metadata).toMatchObject({
          model: CLASSIFIER_MODEL,
          provider: "mistral",
        });
        expect(span?.input).toEqual(expect.any(String));
        expect(span?.output).toEqual(expect.any(Array));
        expect((span?.output as unknown[] | undefined)?.length).toBe(1);
      });

      test("captures trace for classifiers.moderateChat()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "mistral-classifiers-moderate-chat-operation",
        );
        const span = findMistralSpan(events, operation?.span.id, [
          "mistral.classifiers.moderateChat",
        ]);
        const input = span?.input as Array<{ role?: string }> | undefined;

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.span.type).toBe("llm");
        expect(span?.row.metadata).toMatchObject({
          model: CLASSIFIER_MODEL,
          provider: "mistral",
        });
        expect(input).toEqual(expect.any(Array));
        expect(input?.[0]?.role).toBe("user");
        expect(span?.output).toEqual(expect.any(Array));
        expect((span?.output as unknown[] | undefined)?.length).toBe(1);
      });
    }

    if (supportsClassifiers && supportsClassify) {
      test("captures trace for classifiers.classify()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "mistral-classifiers-classify-operation",
        );
        const span = findMistralSpan(events, operation?.span.id, [
          "mistral.classifiers.classify",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.span.type).toBe("llm");
        expect(span?.row.metadata).toMatchObject({
          model: classifyModel,
          provider: "mistral",
        });
        expect(span?.input).toEqual(expect.any(String));
        expect(span?.output).toEqual(expect.any(Array));
        expect((span?.output as unknown[] | undefined)?.length).toBe(1);
      });

      test("captures trace for classifiers.classifyChat()", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "mistral-classifiers-classify-chat-operation",
        );
        const span = findMistralSpan(events, operation?.span.id, [
          "mistral.classifiers.classifyChat",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.span.type).toBe("llm");
        expect(span?.row.metadata).toMatchObject({
          model: classifyModel,
          provider: "mistral",
        });
        expect(span?.input).toEqual(expect.any(Object));
        expect(span?.output).toEqual(expect.any(Array));
        expect((span?.output as unknown[] | undefined)?.length).toBe(1);
      });
    }

    test("matches the shared span tree snapshot", testConfig, async () => {
      await matchFileSnapshot(formatSpanTreeSnapshot(events), spanSnapshotPath);
    });
  });
}
