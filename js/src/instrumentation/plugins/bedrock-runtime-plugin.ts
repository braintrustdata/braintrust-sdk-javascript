import { BasePlugin } from "../core";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import type { Span } from "../../logger";
import type { AnyAsyncChannel } from "../core/channel-definitions";
import type {
  BedrockRuntimeConverseRequest,
  BedrockRuntimeConverseResponse,
  BedrockRuntimeConverseStreamEvent,
  BedrockRuntimeInvokeModelRequest,
  BedrockRuntimeResponseStreamEvent,
  BedrockRuntimeTokenUsage,
} from "../../vendor-sdk-types/bedrock-runtime";
import {
  bedrockRuntimeChannels,
  smithyClientChannels,
  smithyCoreChannels,
} from "./bedrock-runtime-channels";
import {
  buildBedrockRuntimeSpanInfo,
  getBedrockRuntimeCommandInput,
  getBedrockRuntimeCommandName,
  getBedrockRuntimeOperation,
} from "./bedrock-runtime-common";

export class BedrockRuntimePlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      ...[
        bedrockRuntimeChannels.clientSend,
        smithyCoreChannels.clientSend,
        smithyClientChannels.clientSend,
      ].map((channel) => traceBedrockRuntimeClientSendChannel(channel)),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function traceBedrockRuntimeClientSendChannel(
  channel: AnyAsyncChannel,
): () => void {
  return traceStreamingChannel(channel, {
    name: ([command]) => buildBedrockRuntimeSpanInfo(command).name,
    shouldTrace: ([command, optionsOrCb, cb]) =>
      getBedrockRuntimeOperation(command) !== undefined &&
      typeof optionsOrCb !== "function" &&
      typeof cb !== "function",
    type: SpanTypeAttribute.LLM,
    extractInput: ([command]) => extractBedrockRuntimeInput(command),
    extractOutput: (result, endEvent) =>
      extractBedrockRuntimeOutput(endEvent?.arguments?.[0], result),
    extractMetadata: (result, endEvent) =>
      extractBedrockRuntimeResponseMetadata(endEvent?.arguments?.[0], result),
    extractMetrics: (result) => extractBedrockRuntimeResponseMetrics(result),
    patchResult: ({ endEvent, result, span, startTime }) =>
      patchBedrockRuntimeStreamingResult({
        command: endEvent.arguments?.[0],
        result,
        span,
        startTime,
      }),
  });
}

function extractBedrockRuntimeInput(command: unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const operation = getBedrockRuntimeOperation(command);
  const commandName = getBedrockRuntimeCommandName(command);
  const request = getBedrockRuntimeCommandInput(command);
  const metadata = {
    provider: "aws-bedrock",
    ...(commandName ? { command: commandName } : {}),
    ...(operation ? { operation } : {}),
    ...extractBedrockRuntimeRequestMetadata(request),
  };

  if (operation === "converse" || operation === "converseStream") {
    const converseRequest = isObject(request)
      ? (request as BedrockRuntimeConverseRequest)
      : undefined;
    return {
      input: sanitizeBedrockValue({
        messages: converseRequest?.messages,
        system: converseRequest?.system,
      }),
      metadata,
    };
  }

  if (
    operation === "invokeModel" ||
    operation === "invokeModelWithResponseStream"
  ) {
    const invokeRequest = isObject(request)
      ? (request as BedrockRuntimeInvokeModelRequest)
      : undefined;
    return {
      input:
        parseJsonBody(invokeRequest?.body) ??
        summarizeBody(invokeRequest?.body),
      metadata,
    };
  }

  return {
    input: sanitizeBedrockValue(request),
    metadata,
  };
}

function extractBedrockRuntimeRequestMetadata(
  request: unknown,
): Record<string, unknown> {
  if (!isObject(request)) {
    return {};
  }

  const metadata: Record<string, unknown> = {};
  for (const key of [
    "modelId",
    "contentType",
    "accept",
    "trace",
    "guardrailIdentifier",
    "guardrailVersion",
    "performanceConfig",
    "performanceConfigLatency",
    "serviceTier",
  ]) {
    const value = request[key];
    if (value !== undefined) {
      metadata[key === "modelId" ? "model" : key] = value;
    }
  }

  if (isObject(request.inferenceConfig)) {
    Object.assign(metadata, sanitizeBedrockValue(request.inferenceConfig));
  }

  return metadata;
}

function extractBedrockRuntimeOutput(
  command: unknown,
  result: unknown,
): unknown {
  const operation = getBedrockRuntimeOperation(command);
  if (operation === "converse") {
    return sanitizeBedrockValue(
      (result as BedrockRuntimeConverseResponse | undefined)?.output?.message,
    );
  }

  if (operation === "invokeModel") {
    const response = isObject(result) ? result : undefined;
    return parseJsonBody(response?.body) ?? summarizeBody(response?.body);
  }

  return sanitizeBedrockValue(result);
}

function extractBedrockRuntimeResponseMetadata(
  command: unknown,
  result: unknown,
): Record<string, unknown> | undefined {
  const operation = getBedrockRuntimeOperation(command);
  if (!isObject(result)) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  for (const key of [
    "stopReason",
    "contentType",
    "performanceConfig",
    "performanceConfigLatency",
    "serviceTier",
  ]) {
    const value = result[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }

  if (
    operation === "converse" &&
    result.additionalModelResponseFields !== undefined
  ) {
    metadata.additionalModelResponseFields = sanitizeBedrockValue(
      result.additionalModelResponseFields,
    );
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractBedrockRuntimeResponseMetrics(
  result: unknown,
): Record<string, number> {
  if (!isObject(result)) {
    return {};
  }

  const parsedBody = parseJsonBody(result.body);
  if (isObject(parsedBody)) {
    const metadata = isObject(parsedBody.metadata)
      ? parsedBody.metadata
      : undefined;
    const metrics = parseBedrockRuntimeMetrics(
      parsedBody.usage ?? metadata?.usage,
      parsedBody.metrics ?? metadata?.metrics,
    );
    if (Object.keys(metrics).length > 0) {
      return metrics;
    }
  }

  return parseBedrockRuntimeMetrics(result.usage, result.metrics);
}

export function parseBedrockRuntimeMetrics(
  usage: unknown,
  responseMetrics?: unknown,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  const usageRecord = isObject(usage)
    ? (usage as BedrockRuntimeTokenUsage)
    : {};

  if (typeof usageRecord.inputTokens === "number") {
    metrics.prompt_tokens = usageRecord.inputTokens;
  }
  if (typeof usageRecord.outputTokens === "number") {
    metrics.completion_tokens = usageRecord.outputTokens;
  }
  if (typeof usageRecord.totalTokens === "number") {
    metrics.tokens = usageRecord.totalTokens;
  }
  if (typeof usageRecord.cacheReadInputTokens === "number") {
    metrics.prompt_cached_tokens = usageRecord.cacheReadInputTokens;
  }
  if (typeof usageRecord.cacheWriteInputTokens === "number") {
    metrics.prompt_cache_creation_tokens = usageRecord.cacheWriteInputTokens;
  }

  if (
    isObject(responseMetrics) &&
    typeof responseMetrics.latencyMs === "number"
  ) {
    metrics.latency_ms = responseMetrics.latencyMs;
  }

  return metrics;
}

function patchBedrockRuntimeStreamingResult(args: {
  command: unknown;
  result: unknown;
  span: Span;
  startTime: number;
}): boolean {
  const operation = getBedrockRuntimeOperation(args.command);
  if (!isObject(args.result)) {
    return false;
  }

  if (operation === "converseStream" && isAsyncIterable(args.result.stream)) {
    patchConverseStream(
      args.result.stream as AsyncIterable<BedrockRuntimeConverseStreamEvent>,
      args.span,
      args.startTime,
    );
    return true;
  }

  if (
    operation === "invokeModelWithResponseStream" &&
    isAsyncIterable(args.result.body)
  ) {
    patchInvokeModelResponseStream(
      args.result.body as AsyncIterable<BedrockRuntimeResponseStreamEvent>,
      args.span,
      args.startTime,
    );
    return true;
  }

  return false;
}

function patchConverseStream(
  stream: AsyncIterable<BedrockRuntimeConverseStreamEvent>,
  span: Span,
  startTime: number,
): void {
  let firstChunkTime: number | undefined;
  patchStreamIfNeeded<BedrockRuntimeConverseStreamEvent>(stream, {
    onChunk: (chunk) => {
      if (firstChunkTime === undefined && isObject(chunk.contentBlockDelta)) {
        firstChunkTime = getCurrentUnixTimestamp();
      }
    },
    onComplete: (chunks) => {
      const aggregated = aggregateBedrockConverseStreamChunks(chunks);
      const metrics = { ...aggregated.metrics };
      if (firstChunkTime !== undefined) {
        metrics.time_to_first_token = firstChunkTime - startTime;
      }

      span.log({
        output: aggregated.output,
        ...(aggregated.metadata ? { metadata: aggregated.metadata } : {}),
        metrics,
      });
      span.end();
    },
    onError: (error) => {
      span.log({ error: error.message });
      span.end();
    },
  });
}

function patchInvokeModelResponseStream(
  stream: AsyncIterable<BedrockRuntimeResponseStreamEvent>,
  span: Span,
  startTime: number,
): void {
  let firstChunkTime: number | undefined;
  patchStreamIfNeeded<BedrockRuntimeResponseStreamEvent>(stream, {
    onChunk: (chunk) => {
      if (firstChunkTime === undefined && isObject(chunk.chunk)) {
        firstChunkTime = getCurrentUnixTimestamp();
      }
    },
    onComplete: (chunks) => {
      const aggregated = aggregateInvokeModelResponseStreamChunks(chunks);
      const metrics = { ...aggregated.metrics };
      if (firstChunkTime !== undefined) {
        metrics.time_to_first_token = firstChunkTime - startTime;
      }

      span.log({
        output: aggregated.output,
        ...(aggregated.metadata ? { metadata: aggregated.metadata } : {}),
        metrics,
      });
      span.end();
    },
    onError: (error) => {
      span.log({ error: error.message });
      span.end();
    },
  });
}

export function aggregateBedrockConverseStreamChunks(
  chunks: BedrockRuntimeConverseStreamEvent[],
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  let role: string | undefined;
  let stopReason: string | undefined;
  let usage: unknown;
  let responseMetrics: unknown;
  const contentByIndex = new Map<number, Record<string, unknown>>();
  const metadata: Record<string, unknown> = {};

  for (const chunk of chunks) {
    if (typeof chunk.messageStart?.role === "string") {
      role = chunk.messageStart.role;
    }

    const startIndex = chunk.contentBlockStart?.contentBlockIndex;
    if (typeof startIndex === "number") {
      contentByIndex.set(startIndex, {
        ...(contentByIndex.get(startIndex) ?? {}),
        ...sanitizeRecord(chunk.contentBlockStart?.start),
      });
    }

    const deltaIndex = chunk.contentBlockDelta?.contentBlockIndex;
    const delta = chunk.contentBlockDelta?.delta;
    if (typeof deltaIndex === "number" && isObject(delta)) {
      const existing = contentByIndex.get(deltaIndex) ?? {};
      contentByIndex.set(deltaIndex, mergeContentBlockDelta(existing, delta));
    }

    if (typeof chunk.messageStop?.stopReason === "string") {
      stopReason = chunk.messageStop.stopReason;
    }
    if (chunk.messageStop?.additionalModelResponseFields !== undefined) {
      metadata.additionalModelResponseFields = sanitizeBedrockValue(
        chunk.messageStop.additionalModelResponseFields,
      );
    }
    if (chunk.metadata?.usage !== undefined) {
      usage = chunk.metadata.usage;
    }
    if (chunk.metadata?.metrics !== undefined) {
      responseMetrics = chunk.metadata.metrics;
    }
    if (chunk.metadata?.performanceConfig !== undefined) {
      metadata.performanceConfig = sanitizeBedrockValue(
        chunk.metadata.performanceConfig,
      );
    }
    if (chunk.metadata?.serviceTier !== undefined) {
      metadata.serviceTier = chunk.metadata.serviceTier;
    }
  }

  if (stopReason !== undefined) {
    metadata.stopReason = stopReason;
  }

  const content = [...contentByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .filter((value) => Object.keys(value).length > 0);

  return {
    output: {
      role,
      content,
    },
    metrics: parseBedrockRuntimeMetrics(usage, responseMetrics),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function aggregateInvokeModelResponseStreamChunks(
  chunks: BedrockRuntimeResponseStreamEvent[],
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  const parsedChunks = chunks
    .map((chunk) => parseJsonBody(chunk.chunk?.bytes))
    .filter((chunk) => chunk !== undefined);
  const jsonLikeChunks = parsedChunks.filter(isObject);
  const text = parsedChunks.map(extractTextFromJsonLike).join("");
  const lastMetadataChunk = jsonLikeChunks
    .slice()
    .reverse()
    .find((chunk) => isObject(chunk.metadata));
  const metadata = isObject(lastMetadataChunk?.metadata)
    ? sanitizeRecord(lastMetadataChunk.metadata)
    : undefined;

  return {
    output:
      text.length > 0
        ? { text }
        : {
            chunk_count: chunks.length,
            chunks: sanitizeBedrockValue(jsonLikeChunks.slice(0, 20)),
          },
    metrics: parseBedrockRuntimeMetrics(
      isObject(metadata) ? metadata.usage : undefined,
      isObject(metadata) ? metadata.metrics : undefined,
    ),
    ...(metadata ? { metadata } : {}),
  };
}

function mergeContentBlockDelta(
  existing: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  if (typeof delta.text === "string") {
    next.text = `${typeof next.text === "string" ? next.text : ""}${delta.text}`;
  }
  if (isObject(delta.reasoningContent)) {
    const existingReasoning = isObject(next.reasoningContent)
      ? next.reasoningContent
      : {};
    next.reasoningContent = {
      ...existingReasoning,
      ...sanitizeRecord(delta.reasoningContent),
      ...(typeof delta.reasoningContent.text === "string"
        ? {
            text: `${typeof existingReasoning.text === "string" ? existingReasoning.text : ""}${delta.reasoningContent.text}`,
          }
        : {}),
    };
  }
  if (isObject(delta.toolUse)) {
    const existingToolUse = isObject(next.toolUse) ? next.toolUse : {};
    next.toolUse = {
      ...existingToolUse,
      ...sanitizeRecord(delta.toolUse),
      ...(typeof delta.toolUse.input === "string"
        ? {
            input: `${typeof existingToolUse.input === "string" ? existingToolUse.input : ""}${delta.toolUse.input}`,
          }
        : {}),
    };
  }

  for (const [key, value] of Object.entries(delta)) {
    if (key !== "text" && key !== "reasoningContent" && key !== "toolUse") {
      next[key] = sanitizeBedrockValue(value);
    }
  }

  return next;
}

function parseJsonBody(body: unknown): unknown | undefined {
  const text = decodeBodyToString(body);
  if (text === undefined || text.length === 0) {
    return undefined;
  }

  try {
    return sanitizeBedrockValue(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function summarizeBody(body: unknown): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }

  const text = decodeBodyToString(body);
  if (text !== undefined) {
    return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
  }

  return sanitizeBedrockValue(body);
}

function decodeBodyToString(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  return undefined;
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
  return isObject(value)
    ? (sanitizeBedrockValue(value) as Record<string, unknown>)
    : {};
}

function sanitizeBedrockValue(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return { byte_length: value.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { byte_length: value.byteLength };
  }
  if (Array.isArray(value)) {
    return depth > 20
      ? "[MaxDepth]"
      : value.map((item) => sanitizeBedrockValue(item, depth + 1));
  }
  if (!isObject(value)) {
    return String(value);
  }
  if (depth > 20) {
    return "[MaxDepth]";
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = sanitizeBedrockValue(nested, depth + 1);
  }
  return output;
}

function extractTextFromJsonLike(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractTextFromJsonLike).join("");
  }
  if (!isObject(value)) {
    return "";
  }

  const contentBlockDelta = value.contentBlockDelta;
  if (isObject(contentBlockDelta)) {
    return extractTextFromJsonLike(contentBlockDelta.delta);
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.completion === "string") {
    return value.completion;
  }
  if (typeof value.generation === "string") {
    return value.generation;
  }
  if (Array.isArray(value.content)) {
    return value.content.map(extractTextFromJsonLike).join("");
  }
  if (Array.isArray(value.output)) {
    return value.output.map(extractTextFromJsonLike).join("");
  }

  return "";
}
