import { BasePlugin } from "../core";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import { Attachment } from "../../logger";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { filterFrom, getCurrentUnixTimestamp } from "../../util";
import { finalizeAnthropicTokens } from "../../wrappers/anthropic-tokens-util";
import { anthropicChannels } from "./anthropic-channels";
import type {
  AnthropicBase64Source,
  AnthropicCitation,
  AnthropicCreateParams,
  AnthropicInputMessage,
  AnthropicMessage,
  AnthropicOutputContentBlock,
  AnthropicStreamEvent,
  AnthropicUsage,
} from "../../vendor-sdk-types/anthropic";

/**
 * Auto-instrumentation plugin for the Anthropic SDK.
 *
 * This plugin subscribes to orchestrion channels for Anthropic SDK methods
 * and creates Braintrust spans to track:
 * - messages.create (streaming and non-streaming)
 * - beta.messages.create (streaming and non-streaming)
 *
 * The plugin handles:
 * - Anthropic-specific token metrics (including cache tokens)
 * - Processing message streams
 * - Converting base64 attachments to Attachment objects
 * - Streaming and non-streaming responses
 */
export class AnthropicPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToAnthropicChannels();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToAnthropicChannels(): void {
    const anthropicConfig = {
      name: "anthropic.messages.create",
      type: SpanTypeAttribute.LLM,
      extractInput: (args: unknown[]) => {
        const params = (args[0] || {}) as AnthropicCreateParams;
        const input = coalesceInput(params.messages || [], params.system);
        const metadata = filterFrom(params, ["messages", "system"]);
        return {
          input: processAttachmentsInInput(input),
          metadata: { ...metadata, provider: "anthropic" },
        };
      },
      extractOutput: (message: AnthropicMessage) => {
        return message
          ? { role: message.role, content: message.content }
          : null;
      },
      extractMetrics: (message: AnthropicMessage, startTime?: number) => {
        const metrics = parseMetricsFromUsage(message?.usage);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        const finalized = finalizeAnthropicTokens(metrics);
        // Filter out undefined values to match Record<string, number> type
        return Object.fromEntries(
          Object.entries(finalized).filter(
            (entry): entry is [string, number] => entry[1] !== undefined,
          ),
        );
      },
      extractMetadata: (message: AnthropicMessage) => {
        const metadata: Record<string, unknown> = {};
        const metas = ["stop_reason", "stop_sequence"] as const;
        for (const m of metas) {
          if (message?.[m] !== undefined) {
            metadata[m] = message[m];
          }
        }
        return metadata;
      },
      aggregateChunks: (chunks: AnthropicStreamEvent[]) =>
        aggregateAnthropicStreamChunks(chunks),
    };

    // Messages API - supports streaming via stream=true parameter
    this.unsubscribers.push(
      traceStreamingChannel(anthropicChannels.messagesCreate, anthropicConfig),
    );

    // Beta Messages API - supports streaming via stream=true parameter
    this.unsubscribers.push(
      traceStreamingChannel(anthropicChannels.betaMessagesCreate, {
        ...anthropicConfig,
        name: "anthropic.messages.create",
      }),
    );
  }
}

/**
 * Parse metrics from Anthropic usage object.
 * Maps Anthropic's token names to Braintrust's standard names.
 */
export function parseMetricsFromUsage(
  usage: AnthropicUsage | undefined,
): Record<string, number> {
  if (!usage) {
    return {};
  }

  const metrics: Record<string, number> = {};

  function saveIfExistsTo(source: keyof AnthropicUsage, target: string) {
    const value = usage![source];
    if (value !== undefined && value !== null && typeof value === "number") {
      metrics[target] = value;
    }
  }

  saveIfExistsTo("input_tokens", "prompt_tokens");
  saveIfExistsTo("output_tokens", "completion_tokens");
  saveIfExistsTo("cache_read_input_tokens", "prompt_cached_tokens");
  saveIfExistsTo("cache_creation_input_tokens", "prompt_cache_creation_tokens");

  return metrics;
}

/**
 * Aggregate Anthropic stream chunks into a single response.
 *
 * Anthropic stream format:
 * - message_start: Contains initial message with usage stats
 * - content_block_start: Start of a content block (text, image, etc.)
 * - content_block_delta: Text deltas to concatenate
 * - message_delta: Final usage stats and metadata
 * - message_stop: End of stream
 */
type ContentBlockAccumulator = {
  textDeltas: string[];
  citations: AnthropicCitation[];
};

export function aggregateAnthropicStreamChunks(
  chunks: AnthropicStreamEvent[],
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
} {
  const fallbackTextDeltas: string[] = [];
  const contentBlocks: Record<number, AnthropicOutputContentBlock> = {};
  const contentBlockDeltas: Record<number, ContentBlockAccumulator> = {};
  let metrics: Record<string, number> = {};
  let metadata: Record<string, unknown> = {};
  let role: string | undefined;

  for (const event of chunks) {
    switch (event?.type) {
      case "message_start":
        // Collect initial metrics from message
        if (event.message?.usage) {
          const initialMetrics = parseMetricsFromUsage(event.message.usage);
          metrics = { ...metrics, ...initialMetrics };
        }
        if (typeof event.message?.role === "string") {
          role = event.message.role;
        }
        break;

      case "content_block_start":
        if (event.content_block) {
          contentBlocks[event.index] = event.content_block;
          contentBlockDeltas[event.index] = { textDeltas: [], citations: [] };
        }
        break;

      case "content_block_delta": {
        const acc = contentBlockDeltas[event.index];
        const delta = event.delta;
        if (!delta) break;
        if (delta.type === "text_delta" && "text" in delta) {
          const text = (delta as { type: string; text: string }).text;
          if (text) {
            if (acc !== undefined) {
              acc.textDeltas.push(text);
            } else {
              fallbackTextDeltas.push(text);
            }
          }
        } else if (
          delta.type === "input_json_delta" &&
          "partial_json" in delta
        ) {
          const partialJson = (delta as { type: string; partial_json: string })
            .partial_json;
          if (partialJson && acc !== undefined) {
            acc.textDeltas.push(partialJson);
          }
        } else if (delta.type === "thinking_delta" && "thinking" in delta) {
          const thinking = (delta as { type: string; thinking: string })
            .thinking;
          if (thinking && acc !== undefined) {
            acc.textDeltas.push(thinking);
          }
        } else if (delta.type === "citations_delta" && "citation" in delta) {
          const citation = (
            delta as { type: string; citation: AnthropicCitation }
          ).citation;
          if (citation && acc !== undefined) {
            acc.citations.push(citation);
          }
        }
        // signature_delta and unknown future delta types: ignored
        break;
      }

      case "content_block_stop":
        finalizeContentBlock(
          event.index,
          contentBlocks,
          contentBlockDeltas,
          fallbackTextDeltas,
        );
        break;

      case "message_delta":
        // Collect final usage stats and metadata
        if (event.usage) {
          const finalMetrics = parseMetricsFromUsage(event.usage);
          metrics = { ...metrics, ...finalMetrics };
        }
        if (event.delta) {
          // stop_reason, stop_sequence, etc.
          metadata = { ...metadata, ...event.delta };
        }
        break;
    }
  }

  const orderedContent = Object.entries(contentBlocks)
    .map(([index, block]) => ({
      block,
      index: Number(index),
    }))
    .filter(({ block }) => block !== undefined)
    .sort((left, right) => left.index - right.index)
    .map(({ block }) => block);

  let output: unknown = fallbackTextDeltas.join("");
  if (orderedContent.length > 0) {
    if (
      orderedContent.every(isTextContentBlock) &&
      orderedContent.every((block) => !block.citations?.length)
    ) {
      output = orderedContent.map((block) => block.text).join("");
    } else {
      output = {
        ...(role ? { role } : {}),
        content: orderedContent,
      };
    }
  }

  const finalized = finalizeAnthropicTokens(metrics);
  // Filter out undefined values to match Record<string, number> type
  const filteredMetrics = Object.fromEntries(
    Object.entries(finalized).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );

  return {
    output,
    metrics: filteredMetrics,
    metadata,
  };
}

function finalizeContentBlock(
  index: number,
  contentBlocks: Record<number, AnthropicOutputContentBlock>,
  contentBlockDeltas: Record<number, ContentBlockAccumulator>,
  fallbackTextDeltas: string[],
): void {
  const contentBlock = contentBlocks[index];
  if (!contentBlock) {
    return;
  }

  const acc = contentBlockDeltas[index];
  const text = acc?.textDeltas.join("") ?? "";

  if (isToolUseContentBlock(contentBlock)) {
    if (!text) {
      return;
    }

    try {
      contentBlocks[index] = {
        ...contentBlock,
        input: JSON.parse(text),
      };
    } catch {
      fallbackTextDeltas.push(text);
      delete contentBlocks[index];
    }
    return;
  }

  if (isTextContentBlock(contentBlock)) {
    if (!text) {
      delete contentBlocks[index];
      return;
    }

    const updated: AnthropicOutputContentBlock = { ...contentBlock, text };
    if (acc?.citations.length) {
      (
        updated as {
          type: "text";
          text: string;
          citations?: AnthropicCitation[];
        }
      ).citations = acc.citations;
    }
    contentBlocks[index] = updated;
    return;
  }

  if (isThinkingContentBlock(contentBlock)) {
    if (!text) {
      delete contentBlocks[index];
      return;
    }

    contentBlocks[index] = {
      ...contentBlock,
      thinking: text,
    };
    return;
  }

  // Forward-compatible default: preserve unrecognized blocks as-is rather than deleting.
  // This ensures future Anthropic content block types (server_tool_use, web_search_tool_result, etc.)
  // are not silently dropped from traces.
}

function isTextContentBlock(
  contentBlock: AnthropicOutputContentBlock,
): contentBlock is Extract<AnthropicOutputContentBlock, { type: "text" }> {
  return contentBlock.type === "text";
}

function isToolUseContentBlock(
  contentBlock: AnthropicOutputContentBlock,
): contentBlock is Extract<AnthropicOutputContentBlock, { type: "tool_use" }> {
  return contentBlock.type === "tool_use";
}

function isThinkingContentBlock(
  contentBlock: AnthropicOutputContentBlock,
): contentBlock is Extract<AnthropicOutputContentBlock, { type: "thinking" }> {
  return contentBlock.type === "thinking";
}

function isAnthropicBase64ContentBlock(
  input: Record<string, unknown>,
): input is Record<string, unknown> & {
  source: AnthropicBase64Source;
  type: "image" | "document";
} {
  return (
    (input.type === "image" || input.type === "document") &&
    isObject(input.source) &&
    input.source.type === "base64"
  );
}

/**
 * Helper function to convert base64 content to an Attachment.
 */
function convertBase64ToAttachment(
  source: AnthropicBase64Source,
  contentType: "image" | "document",
): Record<string, unknown> {
  const mediaType =
    typeof source.media_type === "string" ? source.media_type : "image/png";
  const base64Data = source.data;

  if (base64Data && typeof base64Data === "string") {
    // Convert base64 string to Blob
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mediaType });

    // Determine file extension from media type
    const extension = mediaType.split("/")[1] || "bin";
    // Use a descriptive prefix based on content type
    const prefix = contentType === "document" ? "document" : "image";
    const filename = `${prefix}.${extension}`;

    const attachment = new Attachment({
      data: blob,
      filename: filename,
      contentType: mediaType,
    });

    return {
      ...source,
      data: attachment,
    };
  }

  return { ...source };
}

/**
 * Process input to convert base64 attachments (images, PDFs, etc.) to Attachment objects.
 */
export function processAttachmentsInInput(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(processAttachmentsInInput);
  }

  if (isObject(input)) {
    // Check for Anthropic's content blocks with base64 data
    // Supports both "image" and "document" types (for PDFs, etc.)
    if (isAnthropicBase64ContentBlock(input)) {
      return {
        ...input,
        source: convertBase64ToAttachment(input.source, input.type),
      };
    }

    // Recursively process nested objects
    const processed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      processed[key] = processAttachmentsInInput(value);
    }
    return processed;
  }

  return input;
}

/**
 * Convert Anthropic args to the single "input" field Braintrust expects.
 * Combines messages array with system message if present.
 */
function coalesceInput(
  messages: AnthropicInputMessage[],
  system: AnthropicCreateParams["system"],
): AnthropicInputMessage[] {
  // Make a copy because we're going to mutate it
  const input = (messages || []).slice();
  if (system) {
    input.push({ role: "system", content: system });
  }
  return input;
}
