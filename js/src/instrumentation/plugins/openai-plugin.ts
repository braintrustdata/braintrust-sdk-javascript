import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  traceSyncStreamChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { openAIChannels } from "./openai-channels";
import {
  extractOpenAIChatInput,
  extractOpenAIResponsesInput,
  extractOpenAIResponsesMetadata,
  processImagesInOutput,
} from "./openai-span-data";
import {
  interceptOpenAIBatchesRetrieveTraced,
  interceptOpenAIBatchTraceComplete,
  interceptOpenAIFilesCreateTraced,
} from "./openai-batch-instrumentation";
import {
  BRAINTRUST_CACHED_STREAM_METRIC,
  getCachedMetricFromHeaders,
  parseMetricsFromUsage,
} from "../../openai-utils";
import type {
  OpenAIChatChoice,
  OpenAIChatCompletionChunk,
  OpenAIChatLogprobs,
  OpenAIResponseStreamEvent,
} from "../../vendor-sdk-types/openai";

/**
 * Plugin for OpenAI SDK instrumentation.
 *
 * Handles instrumentation for:
 * - Chat completions (streaming and non-streaming)
 * - Embeddings
 * - Moderations
 * - Beta API (parse, stream)
 * - Responses API (create, stream, parse, compact)
 */
export class OpenAIPlugin extends BasePlugin {
  constructor() {
    super();
  }

  protected onEnable(): void {
    this.unsubscribers.push(
      openAIChannels.filesCreateTraced.intercept(
        interceptOpenAIFilesCreateTraced,
      ),
      openAIChannels.batchesRetrieveTraced.intercept(
        interceptOpenAIBatchesRetrieveTraced,
      ),
      openAIChannels.batchesCompleteTrace.intercept(
        interceptOpenAIBatchTraceComplete,
      ),
    );

    // Chat Completions - supports streaming
    this.unsubscribers.push(
      traceStreamingChannel(openAIChannels.chatCompletionsCreate, {
        name: "Chat Completion",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractOpenAIChatInput(params),
        extractOutput: (result) => {
          return result?.choices;
        },
        extractMetrics: (result, startTime, endEvent) => {
          const metrics = withCachedMetric(
            parseMetricsFromUsage(result?.usage),
            result,
            endEvent,
          );
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateChatCompletionChunks,
      }),
    );

    // Embeddings
    this.unsubscribers.push(
      traceAsyncChannel(openAIChannels.embeddingsCreate, {
        name: "Embedding",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input,
            metadata: { ...metadata, provider: "openai" },
          };
        },
        extractOutput: (result) => {
          const embedding = result?.data?.[0]?.embedding;
          return Array.isArray(embedding)
            ? { embedding_length: embedding.length }
            : undefined;
        },
        extractMetrics: (result, _startTime, endEvent) => {
          return withCachedMetric(
            parseMetricsFromUsage(result?.usage),
            result,
            endEvent,
          );
        },
      }),
    );

    // Beta Chat Completions Parse
    this.unsubscribers.push(
      traceStreamingChannel(openAIChannels.betaChatCompletionsParse, {
        name: "Chat Completion",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractOpenAIChatInput(params),
        extractOutput: (result) => {
          return result?.choices;
        },
        extractMetrics: (result, startTime, endEvent) => {
          const metrics = withCachedMetric(
            parseMetricsFromUsage(result?.usage),
            result,
            endEvent,
          );
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateChatCompletionChunks,
      }),
    );

    // Beta Chat Completions Stream (sync method returning event-based stream)
    this.unsubscribers.push(
      traceSyncStreamChannel(openAIChannels.betaChatCompletionsStream, {
        name: "Chat Completion",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractOpenAIChatInput(params),
      }),
    );

    // Moderations
    this.unsubscribers.push(
      traceAsyncChannel(openAIChannels.moderationsCreate, {
        name: "Moderation",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input,
            metadata: { ...metadata, provider: "openai" },
          };
        },
        extractOutput: (result) => {
          return result?.results;
        },
        extractMetrics: (result, _startTime, endEvent) => {
          return withCachedMetric(
            parseMetricsFromUsage(result?.usage),
            result,
            endEvent,
          );
        },
      }),
    );

    // Responses API - create (supports streaming via stream=true param)
    this.unsubscribers.push(
      traceStreamingChannel(openAIChannels.responsesCreate, {
        name: "openai.responses.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractOpenAIResponsesInput(params),
        extractOutput: (result) => {
          return processImagesInOutput(result?.output);
        },
        extractMetadata: (result) => extractOpenAIResponsesMetadata(result),
        extractMetrics: (result, startTime, endEvent) => {
          const metrics = withCachedMetric(
            parseMetricsFromUsage(result?.usage),
            result,
            endEvent,
          );
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateResponseStreamEvents,
      }),
    );

    // Responses API - stream (sync method returning event-based stream)
    this.unsubscribers.push(
      traceSyncStreamChannel(openAIChannels.responsesStream, {
        name: "openai.responses.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractOpenAIResponsesInput(params),
        extractFromEvent: (event) => {
          if (event.type !== "response.completed" || !event.response) {
            return {};
          }

          const response = event.response;
          const data: Record<string, unknown> = {};

          if (response.output !== undefined) {
            data.output = processImagesInOutput(response.output);
          }

          const { usage: _usage, output: _output, ...metadata } = response;
          if (Object.keys(metadata).length > 0) {
            data.metadata = metadata;
          }

          data.metrics = parseMetricsFromUsage(response.usage);
          return data;
        },
      }),
    );

    // Responses API - parse
    this.unsubscribers.push(
      traceStreamingChannel(openAIChannels.responsesParse, {
        name: "openai.responses.parse",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractOpenAIResponsesInput(params),
        extractOutput: (result) => {
          return processImagesInOutput(result?.output);
        },
        extractMetadata: (result) => extractOpenAIResponsesMetadata(result),
        extractMetrics: (result, startTime, endEvent) => {
          const metrics = withCachedMetric(
            parseMetricsFromUsage(result?.usage),
            result,
            endEvent,
          );
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateResponseStreamEvents,
      }),
    );

    // Responses API - compact
    this.unsubscribers.push(
      traceAsyncChannel(openAIChannels.responsesCompact, {
        name: "openai.responses.compact",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractOpenAIResponsesInput(params),
        extractOutput: (result) => {
          return processImagesInOutput(result?.output);
        },
        extractMetadata: (result) => extractOpenAIResponsesMetadata(result),
        extractMetrics: (result, startTime, endEvent) => {
          const metrics = withCachedMetric(
            parseMetricsFromUsage(result?.usage),
            result,
            endEvent,
          );
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function getCachedMetricFromEndEvent(endEvent: unknown): number | undefined {
  if (!isObject(endEvent)) {
    return undefined;
  }

  const response = (endEvent as Record<string, unknown>).response;
  if (!isObject(response)) {
    return undefined;
  }

  const headers = (response as { headers?: unknown }).headers;
  if (!headers || typeof (headers as Headers).get !== "function") {
    return undefined;
  }

  return getCachedMetricFromHeaders(headers as Headers);
}

function withCachedMetric(
  metrics: Record<string, number>,
  result: unknown,
  endEvent?: unknown,
): Record<string, number> {
  if (metrics.cached !== undefined) {
    return metrics;
  }

  const cachedFromEvent = getCachedMetricFromEndEvent(endEvent);
  if (cachedFromEvent !== undefined) {
    return {
      ...metrics,
      cached: cachedFromEvent,
    };
  }

  if (!isObject(result)) {
    return metrics;
  }

  const cached = (result as Record<string, unknown>)[
    BRAINTRUST_CACHED_STREAM_METRIC
  ];

  if (typeof cached !== "number") {
    return metrics;
  }

  return {
    ...metrics,
    cached,
  };
}

function mergeLogprobTokens(
  existing: OpenAIChatLogprobs["content"] | OpenAIChatLogprobs["refusal"],
  incoming: OpenAIChatLogprobs["content"] | OpenAIChatLogprobs["refusal"],
): OpenAIChatLogprobs["content"] | OpenAIChatLogprobs["refusal"] {
  if (incoming === undefined) {
    return existing;
  }

  if (incoming === null) {
    return existing ?? null;
  }

  if (Array.isArray(existing)) {
    return [...existing, ...incoming];
  }

  return [...incoming];
}

function aggregateChatLogprobs(
  existing: OpenAIChatLogprobs | null | undefined,
  incoming: OpenAIChatLogprobs | null | undefined,
): OpenAIChatLogprobs | null | undefined {
  if (incoming === undefined) {
    return existing;
  }

  if (incoming === null) {
    return existing ?? null;
  }

  const aggregated: OpenAIChatLogprobs =
    existing && existing !== null
      ? { ...existing, ...incoming }
      : { ...incoming };

  const content = mergeLogprobTokens(existing?.content, incoming.content);
  if (content !== undefined) {
    aggregated.content = content;
  }

  const refusal = mergeLogprobTokens(existing?.refusal, incoming.refusal);
  if (refusal !== undefined) {
    aggregated.refusal = refusal;
  }

  return aggregated;
}

type AggregatedChatChoice = {
  index: number;
  role: string | undefined;
  content: string | undefined;
  refusal: string | undefined;
  toolCallsByIndex: Map<
    number,
    NonNullable<OpenAIChatChoice["message"]["tool_calls"]>[number]
  >;
  logprobs: OpenAIChatLogprobs | null | undefined;
  finish_reason: string | null | undefined;
};

function createAggregatedChatChoice(index: number): AggregatedChatChoice {
  return {
    index,
    role: undefined,
    content: undefined,
    refusal: undefined,
    toolCallsByIndex: new Map(),
    logprobs: undefined,
    finish_reason: undefined,
  };
}

function toChatChoice(choice: AggregatedChatChoice): OpenAIChatChoice {
  const toolCalls = Array.from(choice.toolCallsByIndex.entries())
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toolCall);

  return {
    index: choice.index,
    message: {
      role: choice.role,
      content: choice.content,
      ...(choice.refusal !== undefined ? { refusal: choice.refusal } : {}),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    logprobs: choice.logprobs ?? null,
    finish_reason: choice.finish_reason,
  };
}

/**
 * Aggregate chat completion chunks into a single response.
 * Combines role (first), content (concatenated), tool_calls (by index),
 * finish_reason (last), and usage (last chunk).
 */
export function aggregateChatCompletionChunks(
  chunks: OpenAIChatCompletionChunk[],
  streamResult?: unknown,
  endEvent?: unknown,
): {
  output: OpenAIChatChoice[];
  metrics: Record<string, number>;
} {
  const choicesByIndex = new Map<number, AggregatedChatChoice>();
  let metrics: Record<string, number> = {};

  for (const chunk of chunks) {
    if (chunk.usage) {
      metrics = {
        ...metrics,
        ...parseMetricsFromUsage(chunk.usage),
      };
    }

    const choices = chunk.choices;
    if (!choices?.length) {
      continue;
    }

    for (const choice of choices) {
      const choiceIndex = choice.index;
      let aggregatedChoice = choicesByIndex.get(choiceIndex);
      if (!aggregatedChoice) {
        aggregatedChoice = createAggregatedChatChoice(choiceIndex);
        choicesByIndex.set(choiceIndex, aggregatedChoice);
      }

      if (choice.finish_reason) {
        aggregatedChoice.finish_reason = choice.finish_reason;
      }

      aggregatedChoice.logprobs = aggregateChatLogprobs(
        aggregatedChoice.logprobs,
        choice.logprobs,
      );

      const delta = choice.delta;
      if (!delta) {
        continue;
      }

      if (delta.finish_reason) {
        aggregatedChoice.finish_reason = delta.finish_reason;
      }

      if (!aggregatedChoice.role && delta.role) {
        aggregatedChoice.role = delta.role;
      }

      if (delta.content) {
        aggregatedChoice.content =
          (aggregatedChoice.content || "") + delta.content;
      }

      if (delta.refusal) {
        aggregatedChoice.refusal =
          (aggregatedChoice.refusal || "") + delta.refusal;
      }

      if (delta.tool_calls) {
        for (const toolDelta of delta.tool_calls) {
          let aggregatedToolCall = aggregatedChoice.toolCallsByIndex.get(
            toolDelta.index,
          );
          if (!aggregatedToolCall) {
            aggregatedToolCall = {
              function: { arguments: "" },
            };
            aggregatedChoice.toolCallsByIndex.set(
              toolDelta.index,
              aggregatedToolCall,
            );
          }

          if (toolDelta.id !== undefined) {
            aggregatedToolCall.id = toolDelta.id;
          }
          if (toolDelta.type !== undefined) {
            aggregatedToolCall.type = toolDelta.type;
          }
          if (toolDelta.function?.name !== undefined) {
            aggregatedToolCall.function.name = toolDelta.function.name;
          }
          if (toolDelta.function?.arguments !== undefined) {
            aggregatedToolCall.function.arguments +=
              toolDelta.function.arguments;
          }
        }
      }
    }
  }

  metrics = withCachedMetric(metrics, streamResult, endEvent);
  const output = Array.from(choicesByIndex.values())
    .sort((left, right) => left.index - right.index)
    .map(toChatChoice);

  return {
    metrics,
    output:
      output.length > 0
        ? output
        : [toChatChoice(createAggregatedChatChoice(0))],
  };
}

function aggregateResponseStreamEvents(
  chunks: OpenAIResponseStreamEvent[],
  _streamResult?: unknown,
  endEvent?: unknown,
): {
  output: any;
  metrics: Record<string, number>;
  metadata?: Record<string, any>;
} {
  let output: any = undefined;
  let metrics: Record<string, number> = {};
  let metadata: Record<string, any> | undefined = undefined;

  for (const chunk of chunks) {
    if (!chunk || !chunk.type || !chunk.response) {
      continue;
    }
    if (chunk.type !== "response.completed") {
      continue;
    }

    const response = chunk.response;
    if (response?.output !== undefined) {
      output = processImagesInOutput(response.output);
    }

    const { usage: _usage, output: _output, ...rest } = response || {};
    if (Object.keys(rest).length > 0) {
      metadata = rest;
    }

    metrics = parseMetricsFromUsage(response?.usage);
  }

  return {
    output,
    metrics: withCachedMetric(metrics, undefined, endEvent),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export { parseMetricsFromUsage };
