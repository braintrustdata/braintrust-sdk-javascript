import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { getCurrentUnixTimestamp } from "../../util";
import { cohereChannels } from "./cohere-channels";
import type {
  CohereChatResponse,
  CohereChatStreamEvent,
  CohereMetaLike,
  CohereToolCall,
  CohereUsageLike,
} from "../../vendor-sdk-types/cohere";

export class CoherePlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToCohereChannels();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToCohereChannels(): void {
    this.unsubscribers.push(
      traceStreamingChannel(cohereChannels.chat, {
        name: "cohere.chat",
        type: SpanTypeAttribute.LLM,
        extractInput: extractChatInputWithMetadata,
        extractOutput: (result) => extractCohereChatOutput(result),
        extractMetadata: (result) => extractCohereResponseMetadata(result),
        extractMetrics: (result, startTime) => {
          const metrics = parseCohereMetricsFromUsage(result);
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(cohereChannels.chatStream, {
        name: "cohere.chatStream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractChatInputWithMetadata,
        extractOutput: () => undefined,
        extractMetadata: () => undefined,
        extractMetrics: () => ({}),
        aggregateChunks: aggregateCohereChatStreamChunks,
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(cohereChannels.embed, {
        name: "cohere.embed",
        type: SpanTypeAttribute.LLM,
        extractInput: extractEmbedInputWithMetadata,
        extractOutput: extractCohereEmbeddingOutput,
        extractMetadata: (result) => extractCohereResponseMetadata(result),
        extractMetrics: (result) => parseCohereMetricsFromUsage(result),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(cohereChannels.rerank, {
        name: "cohere.rerank",
        type: SpanTypeAttribute.LLM,
        extractInput: extractRerankInputWithMetadata,
        extractOutput: (result) => {
          if (!isObject(result) || !Array.isArray(result.results)) {
            return undefined;
          }

          return result.results.slice(0, 10).map((item) => ({
            index: isObject(item) ? item.index : undefined,
            relevance_score: isObject(item)
              ? ((typeof item.relevanceScore === "number"
                  ? item.relevanceScore
                  : item.relevance_score) ?? null)
              : null,
          }));
        },
        extractMetadata: (result) => extractCohereResponseMetadata(result),
        extractMetrics: (result) => parseCohereMetricsFromUsage(result),
      }),
    );
  }
}

const CHAT_REQUEST_METADATA_ALLOWLIST = new Set([
  "conversationId",
  "conversation_id",
  "frequencyPenalty",
  "frequency_penalty",
  "k",
  "maxInputTokens",
  "max_input_tokens",
  "maxTokens",
  "max_tokens",
  "model",
  "p",
  "preamble",
  "presencePenalty",
  "presence_penalty",
  "priority",
  "promptTruncation",
  "prompt_truncation",
  "rawPrompting",
  "raw_prompting",
  "responseFormat",
  "response_format",
  "safetyMode",
  "safety_mode",
  "searchQueriesOnly",
  "search_queries_only",
  "seed",
  "stopSequences",
  "stop_sequences",
  "strictTools",
  "strict_tools",
  "temperature",
  "toolChoice",
  "tool_choice",
]);

const EMBED_REQUEST_METADATA_ALLOWLIST = new Set([
  "embeddingTypes",
  "embedding_types",
  "inputType",
  "input_type",
  "maxTokens",
  "max_tokens",
  "model",
  "outputDimension",
  "output_dimension",
  "priority",
  "truncate",
]);

const RERANK_REQUEST_METADATA_ALLOWLIST = new Set([
  "maxChunksPerDoc",
  "max_chunks_per_doc",
  "maxTokensPerDoc",
  "max_tokens_per_doc",
  "model",
  "priority",
  "rankFields",
  "rank_fields",
  "returnDocuments",
  "return_documents",
  "topN",
  "top_n",
]);

const RESPONSE_METADATA_ALLOWLIST = new Set([
  "finishReason",
  "finish_reason",
  "generationId",
  "generation_id",
  "id",
  "responseId",
  "responseType",
  "response_id",
  "response_type",
]);

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

function getRequestArg(
  args: unknown[] | unknown,
): Record<string, unknown> | undefined {
  const firstObjectArg = normalizeArgs(args).find((arg) => isObject(arg));
  return isObject(firstObjectArg) ? firstObjectArg : undefined;
}

function addCohereProviderMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    provider: "cohere",
  };
}

function pickAllowedMetadata(
  metadata: Record<string, unknown> | undefined,
  allowlist: ReadonlySet<string>,
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const picked: Record<string, unknown> = {};
  for (const key of allowlist) {
    const value = metadata[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}

function extractChatInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const { message, messages, ...rawMetadata } = request || {};

  return {
    input: processInputAttachments(messages ?? message),
    metadata: addCohereProviderMetadata(
      pickAllowedMetadata(rawMetadata, CHAT_REQUEST_METADATA_ALLOWLIST),
    ),
  };
}

function extractEmbedInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const { inputs, texts, images, ...rawMetadata } = request || {};

  return {
    input: inputs ?? texts ?? images,
    metadata: addCohereProviderMetadata(
      pickAllowedMetadata(rawMetadata, EMBED_REQUEST_METADATA_ALLOWLIST),
    ),
  };
}

function extractRerankInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const { query, documents, ...rawMetadata } = request || {};

  return {
    input: {
      documents,
      query,
    },
    metadata: addCohereProviderMetadata({
      ...pickAllowedMetadata(rawMetadata, RERANK_REQUEST_METADATA_ALLOWLIST),
      ...(Array.isArray(documents) ? { document_count: documents.length } : {}),
    }),
  };
}

export function extractCohereResponseMetadata(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  const responseMetadata = pickAllowedMetadata(
    result,
    RESPONSE_METADATA_ALLOWLIST,
  );

  const meta = isObject(result.meta)
    ? (result.meta as CohereMetaLike)
    : undefined;
  const apiVersion =
    (isObject(meta?.apiVersion) &&
      typeof (meta.apiVersion as Record<string, unknown>).version ===
        "string" &&
      (meta.apiVersion as Record<string, unknown>).version) ||
    (isObject(meta?.api_version) &&
      typeof (meta.api_version as Record<string, unknown>).version ===
        "string" &&
      (meta.api_version as Record<string, unknown>).version);

  const metadata: Record<string, unknown> = {
    ...responseMetadata,
    ...(apiVersion ? { api_version: apiVersion } : {}),
  };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractCohereChatOutput(result: unknown): unknown {
  if (!isObject(result)) {
    return undefined;
  }

  if (isObject(result.message)) {
    return result.message;
  }

  if (typeof result.text !== "string") {
    return undefined;
  }

  const toolCalls = Array.isArray(result.toolCalls)
    ? result.toolCalls
    : Array.isArray(result.tool_calls)
      ? result.tool_calls
      : undefined;

  if (toolCalls && toolCalls.length > 0) {
    return {
      content: result.text,
      role: "assistant",
      toolCalls,
    };
  }

  return result.text;
}

function extractCohereEmbeddingOutput(result: unknown): unknown {
  if (!isObject(result)) {
    return undefined;
  }

  const embeddingLength = getFirstEmbeddingLength(result.embeddings);
  if (embeddingLength === undefined) {
    return undefined;
  }

  return {
    embedding_length: embeddingLength,
  };
}

function getFirstEmbeddingLength(value: unknown): number | undefined {
  if (Array.isArray(value) && Array.isArray(value[0])) {
    return value[0].length;
  }

  if (!isObject(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (Array.isArray(entry) && Array.isArray(entry[0])) {
      return entry[0].length;
    }
  }

  return undefined;
}

function setMetricIfNumber(
  metrics: Record<string, number>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    metrics[key] = value;
  }
}

function mergeUsageMetrics(
  metrics: Record<string, number>,
  usage: unknown,
): Record<string, number> {
  if (!isObject(usage)) {
    return metrics;
  }

  const source = usage as CohereUsageLike;
  setMetricIfNumber(
    metrics,
    "prompt_tokens",
    source.inputTokens ?? source.input_tokens,
  );
  setMetricIfNumber(
    metrics,
    "completion_tokens",
    source.outputTokens ?? source.output_tokens,
  );
  setMetricIfNumber(
    metrics,
    "tokens",
    source.totalTokens ?? source.total_tokens,
  );
  setMetricIfNumber(
    metrics,
    "prompt_cached_tokens",
    source.cachedTokens ?? source.cached_tokens,
  );

  const tokenContainer = isObject(source.tokens) ? source.tokens : undefined;
  if (tokenContainer) {
    setMetricIfNumber(
      metrics,
      "prompt_tokens",
      tokenContainer.inputTokens ?? tokenContainer.input_tokens,
    );
    setMetricIfNumber(
      metrics,
      "completion_tokens",
      tokenContainer.outputTokens ?? tokenContainer.output_tokens,
    );
    setMetricIfNumber(
      metrics,
      "tokens",
      tokenContainer.totalTokens ?? tokenContainer.total_tokens,
    );
  }

  const billedUnits =
    (isObject(source.billedUnits) ? source.billedUnits : undefined) ||
    (isObject(source.billed_units) ? source.billed_units : undefined);
  if (billedUnits) {
    setMetricIfNumber(
      metrics,
      "prompt_tokens",
      billedUnits.inputTokens ?? billedUnits.input_tokens,
    );
    setMetricIfNumber(
      metrics,
      "completion_tokens",
      billedUnits.outputTokens ?? billedUnits.output_tokens,
    );
    setMetricIfNumber(
      metrics,
      "search_units",
      billedUnits.searchUnits ?? billedUnits.search_units,
    );
    setMetricIfNumber(metrics, "classifications", billedUnits.classifications);
    setMetricIfNumber(metrics, "images", billedUnits.images);
    setMetricIfNumber(
      metrics,
      "image_tokens",
      billedUnits.imageTokens ?? billedUnits.image_tokens,
    );
  }

  return metrics;
}

export function parseCohereMetricsFromUsage(
  source: unknown,
): Record<string, number> {
  if (!isObject(source)) {
    return {};
  }

  const metrics: Record<string, number> = {};
  mergeUsageMetrics(metrics, source);

  if ("usage" in source) {
    mergeUsageMetrics(metrics, source.usage);
  }
  if ("meta" in source) {
    mergeUsageMetrics(metrics, source.meta);
  }

  if (
    metrics.tokens === undefined &&
    typeof metrics.prompt_tokens === "number" &&
    typeof metrics.completion_tokens === "number"
  ) {
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  }

  return metrics;
}

function toToolCallArray(value: unknown): CohereToolCall[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is CohereToolCall => isObject(item));
  }

  return isObject(value) ? [value as CohereToolCall] : [];
}

function getToolCallIndex(
  toolCall: CohereToolCall,
  fallbackIndex: number,
): number {
  return typeof toolCall.index === "number" && Number.isInteger(toolCall.index)
    ? toolCall.index
    : fallbackIndex;
}

function appendToolCallDelta(
  existing: CohereToolCall | undefined,
  incoming: CohereToolCall,
): CohereToolCall {
  const currentArguments =
    isObject(existing?.function) &&
    typeof existing.function.arguments === "string"
      ? existing.function.arguments
      : "";
  const incomingArguments =
    isObject(incoming.function) &&
    typeof incoming.function.arguments === "string"
      ? incoming.function.arguments
      : "";

  return {
    ...existing,
    ...incoming,
    function: {
      ...(isObject(existing?.function) ? existing.function : {}),
      ...(isObject(incoming.function) ? incoming.function : {}),
      ...(incomingArguments
        ? { arguments: `${currentArguments}${incomingArguments}` }
        : {}),
    },
  };
}

function extractV8DeltaText(chunk: CohereChatStreamEvent): string | undefined {
  if (!isObject(chunk.delta) || !isObject(chunk.delta.message)) {
    return undefined;
  }

  const content = chunk.delta.message.content;
  if (typeof content === "string") {
    return content;
  }

  if (isObject(content) && typeof content.text === "string") {
    return content.text;
  }

  return undefined;
}

export function aggregateCohereChatStreamChunks(
  chunks: CohereChatStreamEvent[],
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
} {
  const textDeltas: string[] = [];
  const toolCallsByIndex: Record<number, CohereToolCall> = {};
  const toolCallOrder: number[] = [];
  let terminalResponse: CohereChatResponse | undefined;
  let role: string | undefined;
  let finishReason: string | undefined;
  let metadata: Record<string, unknown> = {};
  let metrics: Record<string, number> = {};

  for (const chunk of chunks) {
    if (!isObject(chunk)) {
      continue;
    }

    const eventType =
      typeof chunk.eventType === "string"
        ? chunk.eventType
        : typeof chunk.event_type === "string"
          ? chunk.event_type
          : typeof chunk.type === "string"
            ? chunk.type
            : undefined;

    if (eventType === "text-generation" && typeof chunk.text === "string") {
      textDeltas.push(chunk.text);
      continue;
    }

    if (eventType === "tool-calls-generation") {
      const generatedToolCalls = toToolCallArray(
        Array.isArray(chunk.toolCalls) ? chunk.toolCalls : chunk.tool_calls,
      );

      for (const [index, toolCall] of generatedToolCalls.entries()) {
        const normalizedIndex = getToolCallIndex(toolCall, index);
        if (!toolCallOrder.includes(normalizedIndex)) {
          toolCallOrder.push(normalizedIndex);
        }
        toolCallsByIndex[normalizedIndex] = {
          ...toolCallsByIndex[normalizedIndex],
          ...toolCall,
        };
      }

      if (typeof chunk.text === "string") {
        textDeltas.push(chunk.text);
      }
      continue;
    }

    if (eventType === "stream-end" && isObject(chunk.response)) {
      terminalResponse = chunk.response;
      metrics = {
        ...metrics,
        ...parseCohereMetricsFromUsage(chunk.response),
      };
      metadata = {
        ...metadata,
        ...(extractCohereResponseMetadata(chunk.response) || {}),
      };
      const responseFinishReason =
        typeof chunk.response.finishReason === "string"
          ? chunk.response.finishReason
          : typeof chunk.response.finish_reason === "string"
            ? chunk.response.finish_reason
            : undefined;
      finishReason = responseFinishReason ?? finishReason;
      continue;
    }

    if (eventType === "message-start") {
      if (typeof chunk.id === "string") {
        metadata.id = chunk.id;
      }
      if (isObject(chunk.delta) && isObject(chunk.delta.message)) {
        const messageRole = chunk.delta.message.role;
        if (typeof messageRole === "string") {
          role = messageRole;
        }
      }
      continue;
    }

    if (eventType === "content-delta") {
      const text = extractV8DeltaText(chunk);
      if (text) {
        textDeltas.push(text);
      }
      continue;
    }

    if (eventType === "tool-call-start") {
      const toolCalls =
        isObject(chunk.delta) && isObject(chunk.delta.message)
          ? toToolCallArray(
              Array.isArray(chunk.delta.message.toolCalls)
                ? chunk.delta.message.toolCalls
                : (chunk.delta.message.toolCalls ??
                    chunk.delta.message.tool_calls),
            )
          : [];

      for (const [index, toolCall] of toolCalls.entries()) {
        const normalizedIndex = getToolCallIndex(
          toolCall,
          typeof chunk.index === "number" ? chunk.index : index,
        );
        if (!toolCallOrder.includes(normalizedIndex)) {
          toolCallOrder.push(normalizedIndex);
        }
        toolCallsByIndex[normalizedIndex] = {
          ...toolCallsByIndex[normalizedIndex],
          ...toolCall,
        };
      }
      continue;
    }

    if (eventType === "tool-call-delta") {
      const toolCallDelta =
        isObject(chunk.delta) && isObject(chunk.delta.message)
          ? toToolCallArray(
              chunk.delta.message.toolCalls ?? chunk.delta.message.tool_calls,
            )
          : [];

      if (toolCallDelta.length > 0) {
        const delta = toolCallDelta[0];
        const normalizedIndex = getToolCallIndex(delta, chunk.index ?? 0);
        if (!toolCallOrder.includes(normalizedIndex)) {
          toolCallOrder.push(normalizedIndex);
        }
        toolCallsByIndex[normalizedIndex] = appendToolCallDelta(
          toolCallsByIndex[normalizedIndex],
          delta,
        );
      }
      continue;
    }

    if (eventType === "message-end" && isObject(chunk.delta)) {
      const delta = chunk.delta;
      if (typeof delta.finishReason === "string") {
        finishReason = delta.finishReason;
      } else if (typeof delta.finish_reason === "string") {
        finishReason = delta.finish_reason;
      }

      if (delta.error !== undefined) {
        metadata.error = delta.error;
      }

      metrics = {
        ...metrics,
        ...parseCohereMetricsFromUsage(delta.usage),
      };
    }
  }

  const mergedToolCalls = toolCallOrder
    .sort((left, right) => left - right)
    .map((index) => toolCallsByIndex[index])
    .filter((toolCall): toolCall is CohereToolCall => isObject(toolCall));

  let output: unknown = extractCohereChatOutput(terminalResponse);
  if (output === undefined) {
    const mergedText = textDeltas.join("");
    if (mergedToolCalls.length > 0 || role || mergedText.length > 0) {
      output = {
        ...(role ? { role } : {}),
        ...(mergedText.length > 0 ? { content: mergedText } : {}),
        ...(mergedToolCalls.length > 0 ? { toolCalls: mergedToolCalls } : {}),
      };
    }
  }

  if (finishReason) {
    metadata = {
      ...metadata,
      finish_reason: finishReason,
    };
  }

  return {
    metadata,
    metrics,
    output,
  };
}
