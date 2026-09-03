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
import {
  extractMistralChatInput,
  extractMistralRequestMetadata,
  extractMistralResponseMetadata,
  normalizeMistralChatChoices,
  parseMistralMetricsFromUsage,
} from "./mistral-span-data";
import type {
  MistralChatCompletionChunk,
  MistralChatCompletionChunkChoice,
  MistralChatCompletionEvent,
  MistralContentPart,
  MistralTextContentPart,
  MistralThinkingContentPart,
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
        extractInput: extractMistralChatInputFromArgs,
        extractOutput: (result) => normalizeMistralChatChoices(result?.choices),
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralMetrics(result?.usage, startTime),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.chatStream, {
        name: "mistral.chat.stream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractMistralChatInputFromArgs,
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
      traceAsyncChannel(mistralChannels.classifiersModerate, {
        name: "mistral.classifiers.moderate",
        type: SpanTypeAttribute.LLM,
        extractInput: extractClassifierInputWithMetadata,
        extractOutput: extractClassifierOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result) => parseMistralMetricsFromUsage(result?.usage),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(mistralChannels.classifiersModerateChat, {
        name: "mistral.classifiers.moderateChat",
        type: SpanTypeAttribute.LLM,
        extractInput: extractClassifierInputWithMetadata,
        extractOutput: extractClassifierOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result) => parseMistralMetricsFromUsage(result?.usage),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(mistralChannels.classifiersClassify, {
        name: "mistral.classifiers.classify",
        type: SpanTypeAttribute.LLM,
        extractInput: extractClassifierInputWithMetadata,
        extractOutput: extractClassifierOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result) => parseMistralMetricsFromUsage(result?.usage),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(mistralChannels.classifiersClassifyChat, {
        name: "mistral.classifiers.classifyChat",
        type: SpanTypeAttribute.LLM,
        extractInput: extractClassifierInputWithMetadata,
        extractOutput: extractClassifierOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result) => parseMistralMetricsFromUsage(result?.usage),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.fimComplete, {
        name: "mistral.fim.complete",
        type: SpanTypeAttribute.LLM,
        extractInput: extractPromptInputWithMetadata,
        extractOutput: (result) => normalizeMistralChatChoices(result?.choices),
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
        extractInput: extractMistralChatInputFromArgs,
        extractOutput: (result) => normalizeMistralChatChoices(result?.choices),
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralMetrics(result?.usage, startTime),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(mistralChannels.agentsStream, {
        name: "mistral.agents.stream",
        type: SpanTypeAttribute.LLM,
        extractInput: extractMistralChatInputFromArgs,
        extractOutput: extractMistralStreamOutput,
        extractMetadata: (result) => extractMistralResponseMetadata(result),
        extractMetrics: (result, startTime) =>
          extractMistralStreamingMetrics(result, startTime),
        aggregateChunks: aggregateMistralStreamChunks,
      }),
    );
  }
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

function isMistralChatCompletionChunk(
  value: unknown,
): value is MistralChatCompletionChunk {
  return isObject(value);
}

function isMistralChunkChoice(
  value: unknown,
): value is MistralChatCompletionChunkChoice {
  return isObject(value);
}

function extractMistralChatInputFromArgs(args: unknown[] | unknown) {
  return extractMistralChatInput(getMistralRequestArg(args) ?? {});
}

function extractEmbeddingInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getMistralRequestArg(args);
  const { inputs, ...rawMetadata } = params || {};

  return {
    input: inputs,
    metadata: addMistralProviderMetadata(
      extractMistralRequestMetadata(rawMetadata),
    ),
  };
}

function extractClassifierInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getMistralRequestArg(args);
  const { input, inputs, ...rawMetadata } = params || {};

  return {
    input: processInputAttachments(inputs ?? input),
    metadata: addMistralProviderMetadata(
      extractMistralRequestMetadata(rawMetadata),
    ),
  };
}

function extractPromptInputWithMetadata(args: unknown[] | unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const params = getMistralRequestArg(args);
  const { prompt, ...rawMetadata } = params || {};

  return {
    input: prompt,
    metadata: addMistralProviderMetadata(
      extractMistralRequestMetadata(rawMetadata),
    ),
  };
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
  return isObject(result)
    ? normalizeMistralChatChoices(result.choices)
    : undefined;
}

function extractClassifierOutput(result: unknown): unknown {
  return isObject(result) ? result.results : undefined;
}

function extractMistralStreamingMetrics(
  result: unknown,
  startTime?: number,
): Record<string, number> {
  return extractMistralMetrics(
    isObject(result) ? result.usage : undefined,
    startTime,
  );
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

function normalizeMistralTextContentPart(
  part: unknown,
): MistralTextContentPart | undefined {
  if (
    !isObject(part) ||
    part.type !== "text" ||
    typeof part.text !== "string"
  ) {
    return undefined;
  }

  return {
    type: "text",
    text: part.text,
  };
}

function normalizeMistralThinkingContentPart(
  part: unknown,
): MistralThinkingContentPart | undefined {
  if (!isObject(part) || part.type !== "thinking") {
    return undefined;
  }

  const thinking = Array.isArray(part.thinking)
    ? part.thinking
        .map((thinkingPart) => normalizeMistralTextContentPart(thinkingPart))
        .filter(
          (thinkingPart): thinkingPart is MistralTextContentPart =>
            thinkingPart !== undefined && typeof thinkingPart.text === "string",
        )
    : [];

  return {
    type: "thinking",
    thinking,
  };
}

function normalizeMistralContentParts(content: unknown): MistralContentPart[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((part) => {
      return (
        normalizeMistralTextContentPart(part) ||
        normalizeMistralThinkingContentPart(part)
      );
    })
    .filter((part): part is MistralContentPart => part !== undefined);
}

function mergeMistralTextSegments(
  left: MistralTextContentPart[],
  right: MistralTextContentPart[],
): MistralTextContentPart[] {
  const merged = left.map((part) => ({ ...part }));

  for (const part of right) {
    const lastPart = merged[merged.length - 1];
    if (
      lastPart &&
      lastPart.type === "text" &&
      typeof lastPart.text === "string" &&
      typeof part.text === "string"
    ) {
      lastPart.text += part.text;
      continue;
    }

    merged.push({ ...part });
  }

  return merged;
}

function mergeMistralContentParts(
  left: MistralContentPart[] | undefined,
  right: MistralContentPart[],
): MistralContentPart[] {
  const merged = [...(left || []).map((part) => structuredClone(part))];

  for (const part of right) {
    const lastPart = merged[merged.length - 1];
    if (
      part.type === "text" &&
      lastPart?.type === "text" &&
      typeof lastPart.text === "string" &&
      typeof part.text === "string"
    ) {
      lastPart.text += part.text;
      continue;
    }

    if (
      part.type === "thinking" &&
      lastPart?.type === "thinking" &&
      Array.isArray(lastPart.thinking) &&
      Array.isArray(part.thinking)
    ) {
      lastPart.thinking = mergeMistralTextSegments(
        lastPart.thinking,
        part.thinking,
      );
      continue;
    }

    merged.push(structuredClone(part));
  }

  return merged;
}

function appendMistralContent(
  accumulator: MistralChoiceAccumulator,
  content: unknown,
): void {
  if (typeof content === "string") {
    if (accumulator.contentParts) {
      accumulator.contentParts = mergeMistralContentParts(
        accumulator.contentParts,
        [{ type: "text", text: content }],
      );
      return;
    }

    accumulator.content = `${accumulator.content || ""}${content}`;
    return;
  }

  const normalizedContentParts = normalizeMistralContentParts(content);
  if (normalizedContentParts.length === 0) {
    return;
  }

  const hasStructuredContent = normalizedContentParts.some(
    (part) => part.type !== "text",
  );

  if (!accumulator.contentParts && !hasStructuredContent) {
    const text = extractDeltaText(content);
    if (text) {
      accumulator.content = `${accumulator.content || ""}${text}`;
    }
    return;
  }

  accumulator.contentParts = mergeMistralContentParts(
    accumulator.contentParts ||
      (accumulator.content
        ? [{ type: "text", text: accumulator.content }]
        : []),
    normalizedContentParts,
  );
  delete accumulator.content;
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

type MistralChoiceAccumulator = {
  content?: string;
  contentParts?: MistralContentPart[];
  finishReason?: string | null;
  index: number;
  order: number;
  role?: string;
  toolCalls?: MistralToolCallDelta[];
};

export function aggregateMistralStreamChunks(
  chunks: MistralChatCompletionEvent[],
): {
  output: Record<string, unknown>[] | undefined;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  const choiceAccumulators = new Map<string, MistralChoiceAccumulator>();
  const indexToAccumulatorKey = new Map<number, string>();
  const positionToAccumulatorKey = new Map<number, string>();
  let nextAccumulatorOrder = 0;
  let metrics: Record<string, number> = {};
  let metadata: Record<string, unknown> | undefined;

  for (const event of chunks) {
    const chunk = isMistralChatCompletionChunk(event?.data)
      ? event.data
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

    for (const [choicePosition, rawChoice] of (chunk.choices || []).entries()) {
      if (!isMistralChunkChoice(rawChoice)) {
        continue;
      }
      const choice = rawChoice;
      const choiceIndex =
        typeof choice.index === "number" && choice.index >= 0
          ? choice.index
          : undefined;
      let accumulatorKey =
        choiceIndex !== undefined
          ? indexToAccumulatorKey.get(choiceIndex)
          : undefined;
      if (!accumulatorKey) {
        accumulatorKey = positionToAccumulatorKey.get(choicePosition);
      }
      if (!accumulatorKey) {
        const initialIndex = choiceIndex ?? choicePosition;
        const keyPrefix = choiceIndex !== undefined ? "index" : "position";
        accumulatorKey = `${keyPrefix}:${initialIndex}`;
        choiceAccumulators.set(accumulatorKey, {
          index: initialIndex,
          order: nextAccumulatorOrder++,
        });
      }

      const accumulator = choiceAccumulators.get(accumulatorKey);
      if (!accumulator) {
        continue;
      }

      if (choiceIndex !== undefined) {
        accumulator.index = choiceIndex;
        indexToAccumulatorKey.set(choiceIndex, accumulatorKey);
      }
      positionToAccumulatorKey.set(choicePosition, accumulatorKey);

      const delta = isObject(choice.delta) ? choice.delta : undefined;
      if (delta) {
        if (!accumulator.role && typeof delta.role === "string") {
          accumulator.role = delta.role;
        }

        appendMistralContent(accumulator, delta.content);

        accumulator.toolCalls = mergeToolCallDeltas(
          accumulator.toolCalls,
          getDeltaToolCalls(delta),
        );
      }

      const choiceFinishReason = getChoiceFinishReason(choice);
      if (choiceFinishReason !== undefined) {
        accumulator.finishReason = choiceFinishReason;
      }
    }
  }

  const output = normalizeMistralChatChoices(
    Array.from(choiceAccumulators.values())
      .sort((left, right) =>
        left.index === right.index
          ? left.order - right.order
          : left.index - right.index,
      )
      .map((choice) => ({
        index: choice.index,
        message: {
          ...(choice.role ? { role: choice.role } : {}),
          content: choice.contentParts ?? choice.content ?? null,
          ...(choice.toolCalls ? { toolCalls: choice.toolCalls } : {}),
        },
        ...(choice.finishReason !== undefined
          ? { finishReason: choice.finishReason }
          : {}),
      })),
  );

  return {
    output,
    metrics,
    ...(metadata ? { metadata } : {}),
  };
}
