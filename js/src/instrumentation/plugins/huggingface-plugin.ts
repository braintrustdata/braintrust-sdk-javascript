import {
  traceAsyncChannel,
  traceSyncStreamChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import { BasePlugin } from "../core";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { parseMetricsFromUsage } from "../../openai-utils";
import { huggingFaceChannels } from "./huggingface-channels";
import type {
  HuggingFaceChatCompletion,
  HuggingFaceChatCompletionChunk,
  HuggingFaceFeatureExtractionOutput,
  HuggingFaceTextGenerationDetails,
  HuggingFaceTextGenerationStreamOutput,
} from "../../vendor-sdk-types/huggingface";
import type { Span } from "../../logger";

const REQUEST_METADATA_ALLOWLIST = new Set([
  "dimensions",
  "encoding_format",
  "endpointUrl",
  "max_tokens",
  "model",
  "provider",
  "seed",
  "stop",
  "stream",
  "temperature",
  "top_p",
]);

const RESPONSE_METADATA_ALLOWLIST = new Set([
  "created",
  "id",
  "model",
  "object",
]);

export class HuggingFacePlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceAsyncChannel(huggingFaceChannels.chatCompletion, {
        name: "huggingface.chat_completion",
        type: SpanTypeAttribute.LLM,
        extractInput: extractChatInputWithMetadata,
        extractOutput: (result) => result?.choices,
        extractMetadata: (result) => extractResponseMetadata(result),
        extractMetrics: (result) => parseMetricsFromUsage(result?.usage),
      }),
      traceSyncStreamChannel(huggingFaceChannels.chatCompletionStream, {
        name: "huggingface.chat_completion_stream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractChatInputWithMetadata,
        patchResult: ({ result, span, startTime }) =>
          patchChatCompletionStream({
            result,
            span,
            startTime,
          }),
      }),
      traceAsyncChannel(huggingFaceChannels.textGeneration, {
        name: "huggingface.text_generation",
        type: SpanTypeAttribute.LLM,
        extractInput: extractTextGenerationInputWithMetadata,
        extractOutput: (result) =>
          isObject(result) ? { generated_text: result.generated_text } : result,
        extractMetadata: extractTextGenerationMetadata,
        extractMetrics: (result) =>
          extractTextGenerationMetrics(result?.details ?? null),
      }),
      traceSyncStreamChannel(huggingFaceChannels.textGenerationStream, {
        name: "huggingface.text_generation_stream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractTextGenerationInputWithMetadata,
        patchResult: ({ result, span, startTime }) =>
          patchTextGenerationStream({
            result,
            span,
            startTime,
          }),
      }),
      traceAsyncChannel(huggingFaceChannels.featureExtraction, {
        name: "huggingface.feature_extraction",
        type: SpanTypeAttribute.LLM,
        extractInput: extractFeatureExtractionInputWithMetadata,
        extractOutput: summarizeFeatureExtractionOutput,
        extractMetrics: () => ({}),
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function addProviderMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    provider: metadata.provider ?? "huggingface",
  };
}

function normalizeArgs(args: unknown[] | unknown): unknown[] {
  if (Array.isArray(args)) {
    return args;
  }

  if (isArrayLike(args)) {
    return Array.from(args);
  }

  return [args];
}

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return (
    isObject(value) &&
    "length" in value &&
    typeof value.length === "number" &&
    Number.isInteger(value.length) &&
    value.length >= 0
  );
}

function getFirstObjectArg(
  args: unknown[] | unknown,
): Record<string, unknown> | undefined {
  const firstObjectArg = normalizeArgs(args).find((arg) => isObject(arg));
  return isObject(firstObjectArg) ? firstObjectArg : undefined;
}

function pickRequestMetadata(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) {
    return addProviderMetadata({});
  }

  const metadata: Record<string, unknown> = {};
  for (const key of REQUEST_METADATA_ALLOWLIST) {
    const value = params[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }

  if (isObject(params.parameters)) {
    metadata.parameters = params.parameters;
  }

  return addProviderMetadata(metadata);
}

function extractChatInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getFirstObjectArg(args);
  const { messages, ...rawMetadata } = params ?? {};
  return {
    input: messages,
    metadata: pickRequestMetadata(rawMetadata),
  };
}

function extractTextGenerationInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getFirstObjectArg(args);
  const { inputs, ...rawMetadata } = params ?? {};
  return {
    input: inputs,
    metadata: pickRequestMetadata(rawMetadata),
  };
}

function extractFeatureExtractionInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getFirstObjectArg(args);
  const { inputs, ...rawMetadata } = params ?? {};
  return {
    input: inputs,
    metadata: pickRequestMetadata(rawMetadata),
  };
}

function extractResponseMetadata(
  result: HuggingFaceChatCompletion | undefined,
): Record<string, unknown> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  for (const key of RESPONSE_METADATA_ALLOWLIST) {
    const value = result[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractTextGenerationMetrics(
  details: HuggingFaceTextGenerationDetails | null | undefined,
): Record<string, number> {
  if (!isObject(details)) {
    return {};
  }

  const promptTokens = Array.isArray(details.prefill)
    ? details.prefill.length
    : undefined;
  const completionTokens =
    typeof details.generated_tokens === "number"
      ? details.generated_tokens
      : Array.isArray(details.tokens)
        ? details.tokens.length
        : undefined;

  const metrics: Record<string, number> = {};
  if (promptTokens !== undefined) {
    metrics.prompt_tokens = promptTokens;
  }
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }
  if (promptTokens !== undefined || completionTokens !== undefined) {
    metrics.tokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }
  return metrics;
}

function extractTextGenerationMetadata(result: {
  details?: HuggingFaceTextGenerationDetails | null;
}): Record<string, unknown> | undefined {
  if (!isObject(result?.details)) {
    return undefined;
  }

  return typeof result.details.finish_reason === "string"
    ? {
        finish_reason: result.details.finish_reason,
      }
    : undefined;
}

function summarizeFeatureExtractionOutput(
  result: HuggingFaceFeatureExtractionOutput,
): Record<string, number> | undefined {
  if (!Array.isArray(result)) {
    return undefined;
  }

  const first = result[0];
  if (typeof first === "number") {
    return { embedding_length: result.length };
  }

  if (
    Array.isArray(first) &&
    first.every((value) => typeof value === "number")
  ) {
    return {
      embedding_count: result.length,
      embedding_length: first.length,
    };
  }

  if (
    Array.isArray(first) &&
    first.length > 0 &&
    Array.isArray(first[0]) &&
    first[0].every((value) => typeof value === "number")
  ) {
    return {
      embedding_batch_count: result.length,
      embedding_count: first.length,
      embedding_length: first[0].length,
    };
  }

  return undefined;
}

function patchChatCompletionStream(args: {
  result: AsyncIterable<HuggingFaceChatCompletionChunk>;
  span: Span;
  startTime: number;
}): boolean {
  const { result, span, startTime } = args;
  if (!result || !isAsyncIterable(result)) {
    return false;
  }

  let firstChunkTime: number | undefined;
  patchStreamIfNeeded<HuggingFaceChatCompletionChunk>(result, {
    onChunk: () => {
      if (firstChunkTime === undefined) {
        firstChunkTime = getCurrentUnixTimestamp();
      }
    },
    onComplete: (chunks) => {
      const lastChunk = chunks.at(-1);
      const metrics = {
        ...parseMetricsFromUsage(lastChunk?.usage),
        ...(firstChunkTime !== undefined
          ? { time_to_first_token: firstChunkTime - startTime }
          : {}),
      };

      span.log({
        output: aggregateChatCompletionChunks(chunks),
        ...(extractResponseMetadata(lastChunk)
          ? { metadata: extractResponseMetadata(lastChunk) }
          : {}),
        metrics,
      });
      span.end();
    },
    onError: (error) => {
      span.log({
        error: error.message,
      });
      span.end();
    },
  });

  return true;
}

function patchTextGenerationStream(args: {
  result: AsyncIterable<HuggingFaceTextGenerationStreamOutput>;
  span: Span;
  startTime: number;
}): boolean {
  const { result, span, startTime } = args;
  if (!result || !isAsyncIterable(result)) {
    return false;
  }

  let firstChunkTime: number | undefined;
  patchStreamIfNeeded<HuggingFaceTextGenerationStreamOutput>(result, {
    onChunk: () => {
      if (firstChunkTime === undefined) {
        firstChunkTime = getCurrentUnixTimestamp();
      }
    },
    onComplete: (chunks) => {
      const lastChunk = chunks.at(-1);
      span.log({
        output: aggregateTextGenerationStreamChunks(chunks),
        ...(extractTextGenerationStreamMetadata(chunks)
          ? {
              metadata: extractTextGenerationStreamMetadata(chunks),
            }
          : {}),
        metrics: {
          ...extractTextGenerationMetrics(lastChunk?.details ?? null),
          ...parseMetricsFromUsage(lastChunk?.usage),
          ...(firstChunkTime !== undefined
            ? { time_to_first_token: firstChunkTime - startTime }
            : {}),
        },
      });
      span.end();
    },
    onError: (error) => {
      span.log({
        error: error.message,
      });
      span.end();
    },
  });

  return true;
}

function aggregateChatCompletionChunks(
  chunks: HuggingFaceChatCompletionChunk[],
): { choices: Array<Record<string, unknown>> } | undefined {
  if (chunks.length === 0) {
    return undefined;
  }

  const aggregatedChoices = new Map<
    number,
    {
      content: string;
      finish_reason?: string | null;
      role?: string;
    }
  >();

  for (const chunk of chunks) {
    for (const choice of chunk.choices ?? []) {
      const index = typeof choice.index === "number" ? choice.index : 0;
      const existing = aggregatedChoices.get(index) ?? { content: "" };
      const delta = isObject(choice.delta) ? choice.delta : undefined;
      const message = isObject(choice.message) ? choice.message : undefined;

      if (typeof delta?.content === "string") {
        existing.content += delta.content;
      } else if (typeof message?.content === "string") {
        existing.content = message.content;
      }

      if (typeof delta?.role === "string") {
        existing.role = delta.role;
      } else if (typeof message?.role === "string") {
        existing.role = message.role;
      }

      if (choice.finish_reason !== undefined) {
        existing.finish_reason = choice.finish_reason;
      }

      aggregatedChoices.set(index, existing);
    }
  }

  return {
    choices: [...aggregatedChoices.entries()].map(([index, choice]) => ({
      index,
      message: {
        content: choice.content,
        role: choice.role ?? "assistant",
      },
      ...(choice.finish_reason !== undefined
        ? { finish_reason: choice.finish_reason }
        : {}),
    })),
  };
}

function aggregateTextGenerationStreamChunks(
  chunks: HuggingFaceTextGenerationStreamOutput[],
): { generated_text: string; finish_reason?: string | null } | undefined {
  if (chunks.length === 0) {
    return undefined;
  }

  let generatedText = "";
  let finishReason: string | null | undefined;
  for (const chunk of chunks) {
    if (typeof chunk.generated_text === "string") {
      generatedText = chunk.generated_text;
    } else if (typeof chunk.token?.text === "string" && !chunk.token.special) {
      generatedText += chunk.token.text;
    } else if (Array.isArray(chunk.choices)) {
      for (const choice of chunk.choices) {
        if (typeof choice.text === "string") {
          generatedText += choice.text;
        }

        if (choice.finish_reason !== undefined) {
          finishReason = choice.finish_reason;
        }
      }
    }

    if (
      isObject(chunk.details) &&
      typeof chunk.details.finish_reason === "string"
    ) {
      finishReason = chunk.details.finish_reason;
    }
  }

  return {
    generated_text: generatedText,
    ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
  };
}

function extractTextGenerationStreamMetadata(
  chunks: HuggingFaceTextGenerationStreamOutput[],
): Record<string, unknown> | undefined {
  for (let index = chunks.length - 1; index >= 0; index--) {
    const chunk = chunks[index];
    if (
      isObject(chunk?.details) &&
      typeof chunk.details.finish_reason === "string"
    ) {
      return {
        finish_reason: chunk.details.finish_reason,
      };
    }

    if (!Array.isArray(chunk?.choices)) {
      continue;
    }

    const finishReason = chunk.choices.findLast(
      (choice) => choice.finish_reason !== undefined,
    )?.finish_reason;
    if (finishReason !== undefined) {
      return { finish_reason: finishReason };
    }
  }

  return undefined;
}
