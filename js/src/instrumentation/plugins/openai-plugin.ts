import { BasePlugin } from "../core";
import { Attachment } from "../../logger";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { openAIChannels, type OpenAIAsyncEndEvent } from "./openai-channels";
import {
  BRAINTRUST_CACHED_STREAM_METRIC,
  getCachedMetricFromHeaders,
  parseMetricsFromUsage,
} from "../../openai-utils";
import type {
  OpenAIChatChoice,
  OpenAIChatCompletionChunk,
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
 * - Responses API (create, stream, parse)
 */
export class OpenAIPlugin extends BasePlugin<typeof openAIChannels> {
  constructor() {
    super();
  }

  protected onEnable(): void {
    // Chat Completions - supports streaming
    this.subscribeToStreamingChannel(openAIChannels.chatCompletionsCreate, {
      name: "Chat Completion",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        const { messages, ...metadata } = params;
        return {
          input: processInputAttachments(messages),
          metadata: { ...metadata, provider: "openai" },
        };
      },
      extractOutput: (result) => result?.choices,
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
    });

    // Embeddings
    this.subscribeToChannel(openAIChannels.embeddingsCreate, {
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
        // Preserve wrapper parity: old wrapper logged only first embedding length.
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
    });

    // Beta Chat Completions Parse
    this.subscribeToStreamingChannel(openAIChannels.betaChatCompletionsParse, {
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
    });

    // Beta Chat Completions Stream (sync method returning event-based stream)
    this.subscribeToSyncStreamChannel(
      openAIChannels.betaChatCompletionsStream,
      {
        name: "Chat Completion",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { messages, ...metadata } = params;
          return {
            input: processInputAttachments(messages),
            metadata: { ...metadata, provider: "openai" },
          };
        },
      },
    );

    // Moderations
    this.subscribeToChannel(openAIChannels.moderationsCreate, {
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
        // Include cached metric when wrappers annotate usage from headers.
        return withCachedMetric(
          parseMetricsFromUsage(result?.usage),
          result,
          endEvent,
        );
      },
    });

    // Responses API - create (supports streaming via stream=true param)
    this.subscribeToStreamingChannel(openAIChannels.responsesCreate, {
      name: "openai.responses.create",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        const { input, ...metadata } = params;
        return {
          input: processInputAttachments(input),
          metadata: { ...metadata, provider: "openai" },
        };
      },
      extractOutput: (result) => processImagesInOutput(result?.output),
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
    });

    // Responses API - stream (sync method returning event-based stream)
    this.subscribeToSyncStreamChannel(openAIChannels.responsesStream, {
      // Preserve wrapper parity: responses.stream logged as openai.responses.create.
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
    });

    // Responses API - parse
    this.subscribeToStreamingChannel(openAIChannels.responsesParse, {
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
    });
  }

  protected onDisable(): void {
    // Unsubscribers are handled by the base class
  }
}

function getCachedMetricFromEndEvent(
  endEvent?: OpenAIAsyncEndEvent,
): number | undefined {
  const headers = endEvent?.response?.headers;
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }

  return getCachedMetricFromHeaders(headers);
}

function withCachedMetric(
  metrics: Record<string, number>,
  result: unknown,
  endEvent?: OpenAIAsyncEndEvent,
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

  const cached = result[BRAINTRUST_CACHED_STREAM_METRIC];

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

/**
 * Aggregate chat completion chunks into a single response.
 * Combines role (first), content (concatenated), tool_calls (by id),
 * finish_reason (last), and usage (last chunk).
 */
export function aggregateChatCompletionChunks(
  chunks: OpenAIChatCompletionChunk[],
  streamResult?: unknown,
  endEvent?: OpenAIAsyncEndEvent,
): {
  output: OpenAIChatChoice[];
  metrics: Record<string, number>;
} {
  let role = undefined;
  let content = undefined;
  let tool_calls = undefined;
  let finish_reason = undefined;
  let metrics: Record<string, number> = {};

  for (const chunk of chunks) {
    if (chunk.usage) {
      metrics = {
        ...metrics,
        ...parseMetricsFromUsage(chunk.usage),
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      continue;
    }

    if (!role && delta.role) {
      role = delta.role;
    }

    if (delta.finish_reason) {
      finish_reason = delta.finish_reason;
    }

    if (delta.content) {
      content = (content || "") + delta.content;
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
          tool_calls,
        },
        logprobs: null,
        finish_reason,
      },
    ],
  };
}

function aggregateResponseStreamEvents(
  chunks: OpenAIResponseStreamEvent[],
  _streamResult?: unknown,
  endEvent?: OpenAIAsyncEndEvent,
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
