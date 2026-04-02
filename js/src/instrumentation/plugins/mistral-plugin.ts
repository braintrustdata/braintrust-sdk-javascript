import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { getCurrentUnixTimestamp } from "../../util";
import { mistralChannels } from "./mistral-channels";
import type {
  MistralChatCompletionChunk,
  MistralChatCompletionChunkChoice,
  MistralChatCompletionEvent,
  MistralChatCompletionResponse,
  MistralToolCallDelta,
} from "../../vendor-sdk-types/mistral";

export class MistralPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToMistralChannels();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToMistralChannels(): void {
    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.chatComplete, {
        name: "mistral.chat.complete",
        type: SpanTypeAttribute.LLM,
        extractInput: extractMessagesInputWithMetadata,
        extractOutput: (result) => {
          return result?.choices;
        },
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralMetrics(result?.usage, startTime),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.chatStream, {
        name: "mistral.chat.stream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractMessagesInputWithMetadata,
        extractOutput: extractMistralStreamOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralStreamingMetrics(result, startTime),
        aggregateChunks: aggregateMistralStreamChunks,
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(mistralChannels.embeddingsCreate, {
        name: "mistral.embeddings.create",
        type: SpanTypeAttribute.LLM,
        extractInput: extractEmbeddingInputWithMetadata,
        extractOutput: (result) => {
          const embedding = result?.data?.[0]?.embedding;
          return Array.isArray(embedding)
            ? { embedding_length: embedding.length }
            : undefined;
        },
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result) => parseMistralMetricsFromUsage(result?.usage),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.fimComplete, {
        name: "mistral.fim.complete",
        type: SpanTypeAttribute.LLM,
        extractInput: extractPromptInputWithMetadata,
        extractOutput: (result) => {
          return result?.choices;
        },
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralMetrics(result?.usage, startTime),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.fimStream, {
        name: "mistral.fim.stream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractPromptInputWithMetadata,
        extractOutput: extractMistralStreamOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralStreamingMetrics(result, startTime),
        aggregateChunks: aggregateMistralStreamChunks,
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.agentsComplete, {
        name: "mistral.agents.complete",
        type: SpanTypeAttribute.LLM,
        extractInput: extractMessagesInputWithMetadata,
        extractOutput: (result) => {
          return result?.choices;
        },
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralMetrics(result?.usage, startTime),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.agentsStream, {
        name: "mistral.agents.stream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractMessagesInputWithMetadata,
        extractOutput: extractMistralStreamOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralStreamingMetrics(result, startTime),
        aggregateChunks: aggregateMistralStreamChunks,
      }),
    );
  }
}

const TOKEN_NAME_MAP: Record<string, string> = {
  promptTokens: "prompt_tokens",
  inputTokens: "prompt_tokens",
  completionTokens: "completion_tokens",
  outputTokens: "completion_tokens",
  totalTokens: "tokens",
  prompt_tokens: "prompt_tokens",
  input_tokens: "prompt_tokens",
  completion_tokens: "completion_tokens",
  output_tokens: "completion_tokens",
  total_tokens: "tokens",
  promptAudioSeconds: "prompt_audio_seconds",
  prompt_audio_seconds: "prompt_audio_seconds",
};

const TOKEN_DETAIL_PREFIX_MAP: Record<string, string> = {
  promptTokensDetails: "prompt",
  inputTokensDetails: "prompt",
  completionTokensDetails: "completion",
  outputTokensDetails: "completion",
  prompt_tokens_details: "prompt",
  input_tokens_details: "prompt",
  completion_tokens_details: "completion",
  output_tokens_details: "completion",
};

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
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

function getMistralRequestArg(
  args: unknown[] | unknown,
): Record<string, unknown> | undefined {
  const firstObjectArg = normalizeArgs(args).find((arg) => isObject(arg));
  return isObject(firstObjectArg) ? firstObjectArg : undefined;
}

function addMistralProviderMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    provider: "mistral",
  };
}

function extractMessagesInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getMistralRequestArg(args);
  const { messages, ...metadata } = params || {};

  return {
    input: processInputAttachments(messages),
    metadata: addMistralProviderMetadata(metadata),
  };
}

function extractEmbeddingInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getMistralRequestArg(args);
  const { inputs, ...metadata } = params || {};

  return {
    input: inputs,
    metadata: addMistralProviderMetadata(metadata),
  };
}

function extractPromptInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getMistralRequestArg(args);
  const { prompt, ...metadata } = params || {};

  return {
    input: prompt,
    metadata: addMistralProviderMetadata(metadata),
  };
}

function extractMistralResponseMetadata(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  const {
    choices: _choices,
    usage: _usage,
    data: _data,
    ...metadata
  } = result as Record<string, unknown>;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractMistralMetrics(
  usage: unknown,
  startTime?: number,
): Record<string, number> {
  const metrics = parseMistralMetricsFromUsage(usage);
  if (startTime) {
    metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
  }
  return metrics;
}

function extractMistralStreamOutput(result: unknown): unknown {
  return isObject(result) ? result.choices : undefined;
}

function extractMistralStreamingMetrics(
  result: unknown,
  startTime?: number,
): Record<string, number> {
  const metrics = isObject(result)
    ? parseMistralMetricsFromUsage(result.usage)
    : {};
  if (startTime) {
    metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
  }
  return metrics;
}

function extractDeltaText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .map((part) => {
      if (!isObject(part) || part.type !== "text") {
        return "";
      }

      return typeof part.text === "string" ? part.text : "";
    })
    .filter((part) => part.length > 0);

  return textParts.length > 0 ? textParts.join("") : undefined;
}

function getDeltaToolCalls(
  delta: Record<string, unknown>,
): MistralToolCallDelta[] {
  const toolCalls =
    (Array.isArray(delta.toolCalls) && delta.toolCalls) ||
    (Array.isArray(delta.tool_calls) && delta.tool_calls) ||
    [];

  return toolCalls.filter((toolCall) => isObject(toolCall));
}

function getToolCallIndex(toolCall: MistralToolCallDelta): number | undefined {
  return typeof toolCall.index === "number" && toolCall.index >= 0
    ? toolCall.index
    : undefined;
}

function createMergedToolCallDelta(
  delta: MistralToolCallDelta,
): MistralToolCallDelta {
  return {
    ...delta,
    function: {
      ...delta.function,
      arguments:
        typeof delta.function?.arguments === "string"
          ? delta.function.arguments
          : "",
    },
  };
}

function mergeToolCallDeltaPair(
  current: MistralToolCallDelta,
  delta: MistralToolCallDelta,
): MistralToolCallDelta {
  const currentArguments =
    typeof current.function?.arguments === "string"
      ? current.function.arguments
      : "";
  const deltaArguments =
    typeof delta.function?.arguments === "string"
      ? delta.function.arguments
      : "";

  return {
    ...current,
    ...delta,
    function: {
      ...(current.function || {}),
      ...(delta.function || {}),
      arguments: `${currentArguments}${deltaArguments}`,
    },
  };
}

function mergeToolCallDeltas(
  toolCalls: MistralToolCallDelta[] | undefined,
  deltas: MistralToolCallDelta[],
): MistralToolCallDelta[] | undefined {
  if (deltas.length === 0) {
    return toolCalls;
  }

  const merged = toolCalls ? [...toolCalls] : [];
  const indexToPosition = new Map<number, number>();
  const idToPosition = new Map<string, number>();

  for (const [position, toolCall] of merged.entries()) {
    const index = getToolCallIndex(toolCall);
    if (index !== undefined && !indexToPosition.has(index)) {
      indexToPosition.set(index, position);
    }

    if (typeof toolCall.id === "string" && !idToPosition.has(toolCall.id)) {
      idToPosition.set(toolCall.id, position);
    }
  }

  for (const delta of deltas) {
    const deltaIndex = getToolCallIndex(delta);
    const existingByIndex =
      deltaIndex !== undefined ? indexToPosition.get(deltaIndex) : undefined;
    const existingById =
      typeof delta.id === "string" ? idToPosition.get(delta.id) : undefined;
    const existingPosition = existingByIndex ?? existingById;

    if (existingPosition === undefined) {
      const newToolCall = createMergedToolCallDelta(delta);
      merged.push(newToolCall);

      const newPosition = merged.length - 1;
      const newIndex = getToolCallIndex(newToolCall);
      if (newIndex !== undefined && !indexToPosition.has(newIndex)) {
        indexToPosition.set(newIndex, newPosition);
      }
      if (
        typeof newToolCall.id === "string" &&
        !idToPosition.has(newToolCall.id)
      ) {
        idToPosition.set(newToolCall.id, newPosition);
      }
      continue;
    }

    const mergedToolCall = mergeToolCallDeltaPair(
      merged[existingPosition],
      delta,
    );
    merged[existingPosition] = mergedToolCall;

    const mergedIndex = getToolCallIndex(mergedToolCall);
    if (mergedIndex !== undefined && !indexToPosition.has(mergedIndex)) {
      indexToPosition.set(mergedIndex, existingPosition);
    }
    if (
      typeof mergedToolCall.id === "string" &&
      !idToPosition.has(mergedToolCall.id)
    ) {
      idToPosition.set(mergedToolCall.id, existingPosition);
    }
  }

  return merged.length > 0 ? merged : undefined;
}

function getChoiceFinishReason(
  choice: MistralChatCompletionChunkChoice,
): string | null | undefined {
  if (typeof choice.finishReason === "string" || choice.finishReason === null) {
    return choice.finishReason;
  }

  if (
    typeof choice.finish_reason === "string" ||
    choice.finish_reason === null
  ) {
    return choice.finish_reason;
  }

  return undefined;
}

export function parseMistralMetricsFromUsage(
  usage: unknown,
): Record<string, number> {
  if (!isObject(usage)) {
    return {};
  }

  const metrics: Record<string, number> = {};

  for (const [name, value] of Object.entries(usage)) {
    if (typeof value === "number") {
      metrics[TOKEN_NAME_MAP[name] || camelToSnake(name)] = value;
      continue;
    }

    if (!isObject(value)) {
      continue;
    }

    const prefix = TOKEN_DETAIL_PREFIX_MAP[name];
    if (!prefix) {
      continue;
    }

    for (const [nestedName, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue !== "number") {
        continue;
      }

      metrics[`${prefix}_${camelToSnake(nestedName)}`] = nestedValue;
    }
  }

  return metrics;
}

export function aggregateMistralStreamChunks(
  chunks: MistralChatCompletionEvent[],
): {
  output: MistralChatCompletionResponse["choices"];
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  let role: string | undefined;
  let content: string | undefined;
  let toolCalls: MistralToolCallDelta[] | undefined;
  let finishReason: string | null | undefined;
  let metrics: Record<string, number> = {};
  let metadata: Record<string, unknown> | undefined;

  for (const event of chunks) {
    const chunk = isObject(event?.data)
      ? (event.data as MistralChatCompletionChunk)
      : undefined;
    if (!chunk) {
      continue;
    }

    if (isObject(chunk.usage)) {
      metrics = {
        ...metrics,
        ...parseMistralMetricsFromUsage(chunk.usage),
      };
    }

    const chunkMetadata = extractMistralResponseMetadata(chunk);
    if (chunkMetadata) {
      metadata = { ...(metadata || {}), ...chunkMetadata };
    }

    for (const rawChoice of chunk.choices || []) {
      if (!isObject(rawChoice)) {
        continue;
      }
      const choice = rawChoice as MistralChatCompletionChunkChoice;

      const delta = isObject(choice.delta)
        ? (choice.delta as Record<string, unknown>)
        : undefined;
      if (delta) {
        if (!role && typeof delta.role === "string") {
          role = delta.role;
        }

        const deltaText = extractDeltaText(delta.content);
        if (deltaText) {
          content = (content || "") + deltaText;
        }

        toolCalls = mergeToolCallDeltas(toolCalls, getDeltaToolCalls(delta));
      }

      const choiceFinishReason = getChoiceFinishReason(choice);
      if (choiceFinishReason !== undefined) {
        finishReason = choiceFinishReason;
      }
    }
  }

  return {
    output: [
      {
        index: 0,
        message: {
          ...(role ? { role } : {}),
          content: content ?? null,
          ...(toolCalls ? { toolCalls } : {}),
        },
        ...(finishReason !== undefined ? { finishReason } : {}),
      },
    ],
    metrics,
    ...(metadata ? { metadata } : {}),
  };
}
