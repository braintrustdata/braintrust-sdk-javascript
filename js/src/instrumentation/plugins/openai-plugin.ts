import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  traceSyncStreamChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { Attachment } from "../../logger";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { openAIChannels } from "./openai-channels";
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
    // Chat Completions - supports streaming
    this.unsubscribers.push(
      traceStreamingChannel(openAIChannels.chatCompletionsCreate, {
        name: "Chat Completion",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { messages, ...metadata } = params;
          return {
            input: processInputAttachments(messages),
            metadata: { ...metadata, provider: "openai" },
          };
        },
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
        extractInput: ([params]) => {
          const { messages, ...metadata } = params;
          return {
            input: processInputAttachments(messages),
            metadata: { ...metadata, provider: "openai" },
          };
        },
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
        extractInput: ([params]) => {
          const { messages, ...metadata } = params;
          return {
            input: processInputAttachments(messages),
            metadata: { ...metadata, provider: "openai" },
          };
        },
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
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input: processInputAttachments(input),
            metadata: { ...metadata, provider: "openai" },
          };
        },
        extractOutput: (result) => {
          return processImagesInOutput(result?.output);
        },
        extractMetadata: (result) => {
          if (!result) {
            return undefined;
          }
          const { output: _output, usage: _usage, ...metadata } = result;
          return Object.keys(metadata).length > 0 ? metadata : undefined;
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
        aggregateChunks: aggregateResponseStreamEvents,
      }),
    );

    // Responses API - stream (sync method returning event-based stream)
    this.unsubscribers.push(
      traceSyncStreamChannel(openAIChannels.responsesStream, {
        name: "openai.responses.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input: processInputAttachments(input),
            metadata: { ...metadata, provider: "openai" },
          };
        },
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
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input: processInputAttachments(input),
            metadata: { ...metadata, provider: "openai" },
          };
        },
        extractOutput: (result) => {
          return processImagesInOutput(result?.output);
        },
        extractMetadata: (result) => {
          if (!result) {
            return undefined;
          }
          const { output: _output, usage: _usage, ...metadata } = result;
          return Object.keys(metadata).length > 0 ? metadata : undefined;
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
        aggregateChunks: aggregateResponseStreamEvents,
      }),
    );

    // Responses API - compact
    this.unsubscribers.push(
      traceAsyncChannel(openAIChannels.responsesCompact, {
        name: "openai.responses.compact",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input: processInputAttachments(input),
            metadata: { ...metadata, provider: "openai" },
          };
        },
        extractOutput: (result) => {
          return processImagesInOutput(result?.output);
        },
        extractMetadata: (result) => {
          if (!result) {
            return undefined;
          }
          const { output: _output, usage: _usage, ...metadata } = result;
          return Object.keys(metadata).length > 0 ? metadata : undefined;
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

/**
 * Process output to convert base64 images to attachments.
 * Used for Responses API image generation output.
 */
export function processImagesInOutput(output: any): any {
  if (Array.isArray(output)) {
    return output.map(processImagesInOutput);
  }

  if (isObject(output)) {
    if (
      output.type === "image_generation_call" &&
      output.result &&
      typeof output.result === "string"
    ) {
      const fileExtension = output.output_format || "png";
      const contentType = `image/${fileExtension}`;

      const baseFilename =
        output.revised_prompt && typeof output.revised_prompt === "string"
          ? output.revised_prompt.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "_")
          : "generated_image";
      const filename = `${baseFilename}.${fileExtension}`;

      // Convert base64 string to Blob
      const binaryString = atob(output.result);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: contentType });

      const attachment = new Attachment({
        data: blob,
        filename: filename,
        contentType: contentType,
      });

      return {
        ...output,
        result: attachment,
      };
    }
  }

  return output;
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

/**
 * Aggregate chat completion chunks into a single response.
 * Combines role (first), content (concatenated), tool_calls (by id),
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
  let role = undefined;
  let content = undefined;
  let refusal = undefined;
  let tool_calls = undefined;
  let logprobs: OpenAIChatLogprobs | null | undefined = undefined;
  let finish_reason = undefined;
  let metrics: Record<string, number> = {};

  for (const chunk of chunks) {
    if (chunk.usage) {
      metrics = {
        ...metrics,
        ...parseMetricsFromUsage(chunk.usage),
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }

    if (choice.finish_reason) {
      finish_reason = choice.finish_reason;
    }

    logprobs = aggregateChatLogprobs(logprobs, choice.logprobs);

    const delta = choice.delta;
    if (!delta) {
      continue;
    }

    if (!role && delta.role) {
      role = delta.role;
    }

    if (delta.content) {
      content = (content || "") + delta.content;
    }

    if (delta.refusal) {
      refusal = (refusal || "") + delta.refusal;
    }

    if (delta.tool_calls) {
      const toolDelta = delta.tool_calls[0];
      if (
        !tool_calls ||
        (toolDelta.id && tool_calls[tool_calls.length - 1].id !== toolDelta.id)
      ) {
        tool_calls = [
          ...(tool_calls || []),
          {
            id: toolDelta.id,
            type: toolDelta.type,
            function: toolDelta.function,
          },
        ];
      } else {
        tool_calls[tool_calls.length - 1].function.arguments +=
          toolDelta.function.arguments;
      }
    }
  }

  metrics = withCachedMetric(metrics, streamResult, endEvent);

  return {
    metrics,
    output: [
      {
        index: 0,
        message: {
          role,
          content,
          refusal,
          tool_calls,
        },
        logprobs: logprobs ?? null,
        finish_reason,
      },
    ],
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
