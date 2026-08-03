import { SpanTypeAttribute, isObject } from "../../../util/index";
import iso from "../../isomorph";
import { Attachment } from "../../logger";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  OllamaMessage,
  OllamaTool,
  OllamaToolCall,
  OllamaUsageResponse,
} from "../../vendor-sdk-types/ollama";
import { BasePlugin } from "../core";
import type { AsyncEndOf } from "../core/channel-definitions";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { ollamaChannels } from "./ollama-channels";

export class OllamaPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceStreamingChannel(ollamaChannels.chat, {
        name: "ollama.chat",
        type: SpanTypeAttribute.LLM,
        extractInput: extractOllamaChatInput,
        extractOutput: (result, event) =>
          extractOllamaChatOutput(
            result,
            countOllamaToolCalls(event?.arguments[0]?.messages),
          ),
        extractMetadata: extractOllamaResponseMetadata,
        extractMetrics: extractOllamaMetrics,
        aggregateChunks: aggregateOllamaChatChunks,
      }),
      traceStreamingChannel(ollamaChannels.generate, {
        name: "ollama.generate",
        type: SpanTypeAttribute.LLM,
        extractInput: extractOllamaGenerateInput,
        extractOutput: extractOllamaGenerateOutput,
        extractMetadata: extractOllamaResponseMetadata,
        extractMetrics: extractOllamaMetrics,
        aggregateChunks: aggregateOllamaGenerateChunks,
      }),
      traceAsyncChannel(ollamaChannels.embed, {
        name: "ollama.embed",
        type: SpanTypeAttribute.LLM,
        extractInput: extractOllamaEmbedInput,
        extractOutput: extractOllamaEmbedOutput,
        extractMetadata: extractOllamaResponseMetadata,
        extractMetrics: extractOllamaMetrics,
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeFinishReason(
  response: { done_reason?: string } | undefined,
  hasToolCalls = false,
): string {
  if (hasToolCalls) {
    return "tool_calls";
  }
  return response?.done_reason || "stop";
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function syntheticToolCallId(name: string, index: number): string {
  const normalizedName = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
  return `ollama_call_${normalizedName}_${index}`;
}

function normalizeToolCall(
  toolCall: OllamaToolCall,
  index: number,
): Record<string, unknown> | undefined {
  const name = toolCall.function?.name;
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }

  return {
    id:
      typeof toolCall.id === "string" && toolCall.id.length > 0
        ? toolCall.id
        : syntheticToolCallId(name, index),
    type: "function",
    function: {
      name,
      arguments: stringifyArguments(toolCall.function?.arguments),
    },
  };
}

function normalizeToolCalls(
  toolCalls: OllamaToolCall[] | undefined,
  syntheticIdOffset = 0,
): Record<string, unknown>[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.flatMap((toolCall, index) => {
    const normalized = normalizeToolCall(toolCall, syntheticIdOffset + index);
    return normalized ? [normalized] : [];
  });
}

function countOllamaToolCalls(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }

  return messages.reduce(
    (count, message) =>
      count +
      (isObject(message) && Array.isArray(message.tool_calls)
        ? message.tool_calls.length
        : 0),
    0,
  );
}

function imageBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value !== "string" || value.startsWith("data:")) {
    return undefined;
  }
  try {
    const decoded = atob(value.slice(0, 24));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function inferImageMediaType(value: unknown): string | undefined {
  if (typeof value === "string") {
    const dataUrlType = value.match(/^data:(image\/[^;]+);base64,/i)?.[1];
    if (dataUrlType) {
      return dataUrlType;
    }
  }

  const bytes = imageBytes(value);
  if (!bytes) {
    return undefined;
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const signature = String.fromCharCode(...bytes.slice(0, 12));
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function normalizeTextAndImages(
  content: string | null,
  images: unknown[] | undefined,
): {
  content: unknown;
  unrecognizedImages?: unknown[];
} {
  if (!images || images.length === 0) {
    return { content };
  }

  const imageParts: Record<string, unknown>[] = [];
  const unrecognizedImages: unknown[] = [];
  for (const image of images) {
    let localImagePath: string | undefined;
    let localPathMediaType: string | undefined;
    if (
      typeof image === "string" &&
      !/^data:/i.test(image) &&
      !/^https?:\/\//i.test(image)
    ) {
      const extension = image.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
      const extensionMediaType = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
      }[extension ?? ""];
      if (extensionMediaType && iso.statSync) {
        try {
          if (iso.statSync(image).isFile()) {
            localImagePath = image;
            localPathMediaType = extensionMediaType;
          }
        } catch {
          // Ollama treats unreadable strings as base64, so preserve them below.
        }
      }
    }

    const mediaType = localPathMediaType ?? inferImageMediaType(image);
    if (!mediaType) {
      unrecognizedImages.push(image);
      continue;
    }
    const processedImage = localImagePath
      ? new Attachment({
          data: localImagePath,
          filename: localImagePath.split(/[\\/]/).at(-1) ?? "image",
          contentType: mediaType,
        })
      : processInputAttachments({
          type: "image",
          image,
          mediaType,
        }).image;
    imageParts.push({
      type: "image_url",
      image_url: { url: processedImage },
    });
  }

  return {
    content:
      imageParts.length > 0
        ? [...(content ? [{ type: "text", text: content }] : []), ...imageParts]
        : content,
    ...(unrecognizedImages.length > 0 ? { unrecognizedImages } : {}),
  };
}

function normalizeMessage(
  message: OllamaMessage,
  toolCallId?: string,
  syntheticToolCallIdOffset = 0,
): Record<string, unknown> | undefined {
  if (typeof message.role !== "string") {
    return undefined;
  }

  const toolCalls = normalizeToolCalls(
    message.tool_calls,
    syntheticToolCallIdOffset,
  );
  if (message.role === "tool") {
    const toolName =
      typeof message.tool_name === "string" && message.tool_name.length > 0
        ? message.tool_name
        : "tool";
    return {
      role: "tool",
      tool_call_id: toolCallId ?? syntheticToolCallId(toolName, 0),
      content: typeof message.content === "string" ? message.content : "",
    };
  }

  const normalizedContent = normalizeTextAndImages(
    typeof message.content === "string"
      ? message.content || (toolCalls.length > 0 ? null : "")
      : toolCalls.length > 0
        ? null
        : "",
    message.images,
  );
  return {
    role: message.role,
    content: normalizedContent.content,
    ...(typeof message.thinking === "string" && message.thinking.length > 0
      ? { reasoning: message.thinking }
      : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(normalizedContent.unrecognizedImages
      ? { images: normalizedContent.unrecognizedImages }
      : {}),
  };
}

function normalizeMessages(messages: unknown): Record<string, unknown>[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const pendingToolCallIds = new Map<string, string[]>();
  let syntheticToolCallIdOffset = 0;
  return messages.flatMap((message) => {
    if (!isObject(message)) {
      return [];
    }

    const ollamaMessage = message as OllamaMessage;
    let toolCallId: string | undefined;
    if (ollamaMessage.role === "tool") {
      const toolName = ollamaMessage.tool_name;
      if (typeof toolName === "string") {
        toolCallId = pendingToolCallIds.get(toolName)?.shift();
      }
    }

    const normalized = normalizeMessage(
      ollamaMessage,
      toolCallId,
      syntheticToolCallIdOffset,
    );
    if (Array.isArray(ollamaMessage.tool_calls)) {
      syntheticToolCallIdOffset += ollamaMessage.tool_calls.length;
    }
    if (ollamaMessage.role === "assistant" && normalized) {
      const toolCalls = Array.isArray(normalized.tool_calls)
        ? normalized.tool_calls
        : [];
      for (const toolCall of toolCalls) {
        if (!isObject(toolCall) || !isObject(toolCall.function)) {
          continue;
        }
        const name = toolCall.function.name;
        const id = toolCall.id;
        if (typeof name === "string" && typeof id === "string") {
          const ids = pendingToolCallIds.get(name) ?? [];
          ids.push(id);
          pendingToolCallIds.set(name, ids);
        }
      }
    }
    return normalized ? [normalized] : [];
  });
}

function normalizeToolDefinition(
  tool: OllamaTool,
): Record<string, unknown> | undefined {
  const fn = tool.function;
  if (!fn || typeof fn.name !== "string" || fn.name.length === 0) {
    return undefined;
  }

  return {
    type: "function",
    function: {
      name: fn.name,
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      ...(isObject(fn.parameters) ? { parameters: fn.parameters } : {}),
    },
  };
}

function extractToolsMetadata(tools: unknown): Record<string, unknown> {
  if (!Array.isArray(tools)) {
    return {};
  }
  const normalized = tools.flatMap((tool) => {
    if (!isObject(tool)) {
      return [];
    }
    const definition = normalizeToolDefinition(tool as OllamaTool);
    return definition ? [definition] : [];
  });
  return normalized.length > 0 ? { tools: normalized } : {};
}

function extractOptionsMetadata(options: unknown): Record<string, unknown> {
  if (!isObject(options)) {
    return {};
  }

  const metadata: Record<string, unknown> = {};
  const mappings = [
    ["temperature", "temperature"],
    ["top_p", "top_p"],
    ["num_predict", "max_tokens"],
    ["frequency_penalty", "frequency_penalty"],
    ["presence_penalty", "presence_penalty"],
    ["stop", "stop"],
  ] as const;
  for (const [source, target] of mappings) {
    if (options[source] !== undefined) {
      metadata[target] = options[source];
    }
  }
  return metadata;
}

function extractRequestMetadata(
  request:
    | {
        format?: unknown;
        model?: unknown;
        options?: unknown;
      }
    | undefined,
): Record<string, unknown> {
  return {
    provider: "ollama",
    ...(typeof request?.model === "string" ? { model: request.model } : {}),
    ...extractOptionsMetadata(request?.options),
    ...(request?.format !== undefined
      ? { response_format: request.format }
      : {}),
  };
}

export function extractOllamaChatInput([request]: [
  OllamaChatRequest,
  ...unknown[],
]): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  return {
    input: normalizeMessages(request.messages),
    metadata: {
      ...extractRequestMetadata(request),
      ...extractToolsMetadata(request.tools),
    },
  };
}

export function extractOllamaGenerateInput([request]: [
  OllamaGenerateRequest,
  ...unknown[],
]): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const normalizedPrompt = normalizeTextAndImages(
    typeof request.prompt === "string" ? request.prompt : "",
    Array.isArray(request.images) ? request.images : undefined,
  );
  const input = [
    ...(typeof request.system === "string"
      ? [{ role: "system", content: request.system }]
      : []),
    {
      role: "user",
      content: normalizedPrompt.content,
      ...(typeof request.suffix === "string" ? { suffix: request.suffix } : {}),
      ...(normalizedPrompt.unrecognizedImages
        ? { images: normalizedPrompt.unrecognizedImages }
        : {}),
    },
  ];

  return {
    input,
    metadata: extractRequestMetadata(request),
  };
}

function extractOllamaEmbedInput([request]: [
  OllamaEmbedRequest,
  ...unknown[],
]): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  return {
    input: request.input,
    metadata: extractRequestMetadata(request),
  };
}

export function extractOllamaChatOutput(
  result: OllamaChatResponse,
  syntheticToolCallIdOffset = 0,
): unknown {
  if (!isObject(result) || !isObject(result.message)) {
    return undefined;
  }

  const message = normalizeMessage(
    result.message as OllamaMessage,
    undefined,
    syntheticToolCallIdOffset,
  );
  if (!message) {
    return undefined;
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  return [
    {
      index: 0,
      finish_reason: normalizeFinishReason(result, toolCalls.length > 0),
      message,
    },
  ];
}

function extractOllamaGenerateOutput(result: OllamaGenerateResponse): unknown {
  if (!isObject(result) || typeof result.response !== "string") {
    return undefined;
  }

  return [
    {
      index: 0,
      finish_reason: normalizeFinishReason(result),
      message: {
        role: "assistant",
        content: result.response,
        ...(typeof result.thinking === "string" && result.thinking.length > 0
          ? { reasoning: result.thinking }
          : {}),
      },
    },
  ];
}

export function extractOllamaEmbedOutput(result: OllamaEmbedResponse): unknown {
  const embedding = Array.isArray(result?.embeddings)
    ? result.embeddings[0]
    : undefined;
  return Array.isArray(embedding)
    ? { embedding_length: embedding.length }
    : undefined;
}

function extractOllamaResponseMetadata(
  result: OllamaUsageResponse,
): Record<string, unknown> | undefined {
  return typeof result?.model === "string"
    ? { model: result.model }
    : undefined;
}

export function extractOllamaMetrics(
  result: OllamaUsageResponse,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  const promptTokens = result?.prompt_eval_count;
  const completionTokens = result?.eval_count;

  if (isNonNegativeNumber(promptTokens)) {
    metrics.prompt_tokens = promptTokens;
  }
  if (isNonNegativeNumber(completionTokens)) {
    metrics.completion_tokens = completionTokens;
  }
  if (
    isNonNegativeNumber(promptTokens) ||
    isNonNegativeNumber(completionTokens)
  ) {
    metrics.tokens =
      (isNonNegativeNumber(promptTokens) ? promptTokens : 0) +
      (isNonNegativeNumber(completionTokens) ? completionTokens : 0);
  }
  return metrics;
}

export function aggregateOllamaChatChunks(
  chunks: OllamaChatResponse[],
  _result?: unknown,
  event?: AsyncEndOf<typeof ollamaChannels.chat>,
  _startTime?: number,
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  const last = chunks.at(-1);
  const message: OllamaMessage = {
    role: "assistant",
    content: chunks.map((chunk) => chunk.message?.content ?? "").join(""),
    thinking: chunks.map((chunk) => chunk.message?.thinking ?? "").join(""),
    tool_calls: chunks.flatMap((chunk) => chunk.message?.tool_calls ?? []),
  };
  const response: OllamaChatResponse = {
    ...last,
    message,
  };
  return {
    output: extractOllamaChatOutput(
      response,
      countOllamaToolCalls(event?.arguments[0]?.messages),
    ),
    metrics: extractOllamaMetrics(last ?? {}),
    metadata: extractOllamaResponseMetadata(last ?? {}),
  };
}

export function aggregateOllamaGenerateChunks(
  chunks: OllamaGenerateResponse[],
  _result?: unknown,
  _event?: unknown,
  _startTime?: number,
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  const last = chunks.at(-1);
  const response: OllamaGenerateResponse = {
    ...last,
    response: chunks.map((chunk) => chunk.response ?? "").join(""),
    thinking: chunks.map((chunk) => chunk.thinking ?? "").join(""),
  };
  return {
    output: extractOllamaGenerateOutput(response),
    metrics: extractOllamaMetrics(last ?? {}),
    metadata: extractOllamaResponseMetadata(last ?? {}),
  };
}
