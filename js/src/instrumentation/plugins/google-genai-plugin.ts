import { BasePlugin } from "../core";
import { Attachment } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { googleGenAIChannels } from "./google-genai-channels";
import type {
  GoogleGenAIGenerateContentParams,
  GoogleGenAIGenerateContentResponse,
  GoogleGenAIContent,
  GoogleGenAIPart,
  GoogleGenAIUsageMetadata,
} from "../../vendor-sdk-types/google-genai";

/**
 * Auto-instrumentation plugin for the Google GenAI SDK.
 *
 * This plugin subscribes to orchestrion channels for Google GenAI SDK methods
 * and creates Braintrust spans to track:
 * - models.generateContent (non-streaming)
 * - models.generateContentStream (streaming)
 *
 * The plugin handles:
 * - Google-specific token metrics (promptTokenCount, candidatesTokenCount, cachedContentTokenCount)
 * - Processing streaming responses
 * - Converting inline data (images) to Attachment objects
 * - Tool calls (functionCall, functionResponse) and executable code results
 */
export class GoogleGenAIPlugin extends BasePlugin<typeof googleGenAIChannels> {
  protected onEnable(): void {
    this.subscribeToGoogleGenAIChannels();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToGoogleGenAIChannels(): void {
    // GenerativeModel.generateContent (non-streaming)
    this.subscribeToChannel(googleGenAIChannels.generateContent, {
      name: "google-genai.generateContent",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        const input = serializeInput(params);
        const metadata = extractMetadata(params);
        return {
          input,
          metadata: { ...metadata, provider: "google-genai" },
        };
      },
      extractOutput: (result) => result,
      extractMetrics: (result, startTime) =>
        extractGenerateContentMetrics(result, startTime),
    });

    // GenerativeModel.generateContentStream (streaming)
    this.subscribeToStreamingChannel(
      googleGenAIChannels.generateContentStream,
      {
        name: "google-genai.generateContentStream",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const input = serializeInput(params);
          const metadata = extractMetadata(params);
          return {
            input,
            metadata: { ...metadata, provider: "google-genai" },
          };
        },
        extractOutput: (result) => result,
        extractMetrics: () => ({}),
        aggregateChunks: aggregateGenerateContentChunks,
      },
    );
  }
}

/**
 * Serialize input parameters for Google GenAI API calls.
 */
function serializeInput(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    model: params.model,
    contents: serializeContents(params.contents),
  };

  if (params.config) {
    const config = tryToDict(params.config);
    if (config) {
      const tools = serializeTools(params);
      if (tools) {
        config.tools = tools;
      }
      input.config = config;
    }
  }

  return input;
}

/**
 * Serialize contents, converting inline data to Attachments.
 */
function serializeContents(
  contents: GoogleGenAIGenerateContentParams["contents"],
): unknown {
  if (contents === null || contents === undefined) {
    return null;
  }

  if (Array.isArray(contents)) {
    return contents.map((item) => serializeContentItem(item));
  }

  return serializeContentItem(contents);
}

/**
 * Serialize a single content item.
 */
function serializeContentItem(item: string | GoogleGenAIContent): unknown {
  if (typeof item === "object" && item !== null) {
    if (item.parts && Array.isArray(item.parts)) {
      return {
        ...item,
        parts: item.parts.map((part: GoogleGenAIPart) => serializePart(part)),
      };
    }
    return item;
  }

  if (typeof item === "string") {
    return { text: item };
  }

  return item;
}

/**
 * Serialize a part, converting inline data to Attachments.
 */
function serializePart(part: GoogleGenAIPart): unknown {
  if (!part || typeof part !== "object") {
    return part;
  }

  if (part.inlineData && part.inlineData.data) {
    const { data, mimeType } = part.inlineData;

    // Handle binary data (Uint8Array/Buffer) or base64 strings
    if (
      data instanceof Uint8Array ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) ||
      typeof data === "string"
    ) {
      const extension = mimeType ? mimeType.split("/")[1] : "bin";
      const filename = `file.${extension}`;

      // Convert to Buffer/Uint8Array - handles Uint8Array, Buffer, and base64 strings
      const buffer =
        typeof data === "string"
          ? typeof Buffer !== "undefined"
            ? Buffer.from(data, "base64")
            : new Uint8Array(
                atob(data)
                  .split("")
                  .map((c) => c.charCodeAt(0)),
              )
          : typeof Buffer !== "undefined"
            ? Buffer.from(data)
            : new Uint8Array(data);

      // Convert to ArrayBuffer for Attachment compatibility
      const arrayBuffer =
        buffer instanceof Uint8Array
          ? buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            )
          : buffer;

      const attachment = new Attachment({
        data: arrayBuffer,
        filename,
        contentType: mimeType || "application/octet-stream",
      });

      return {
        image_url: { url: attachment },
      };
    }
  }

  return part;
}

/**
 * Serialize tools configuration.
 */
function serializeTools(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown>[] | null {
  if (!params.config?.tools) {
    return null;
  }

  try {
    return params.config.tools.map((tool) => {
      if (typeof tool === "object" && tool.functionDeclarations) {
        return tool;
      }
      return tool;
    });
  } catch {
    return null;
  }
}

/**
 * Extract metadata from parameters.
 */
function extractMetadata(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (params.model) {
    metadata.model = params.model;
  }

  if (params.config) {
    const config = tryToDict(params.config);
    if (config) {
      Object.keys(config).forEach((key) => {
        if (key !== "tools") {
          metadata[key] = config[key];
        }
      });
    }
  }

  return metadata;
}

/**
 * Extract metrics from non-streaming generateContent response.
 */
function extractGenerateContentMetrics(
  response: GoogleGenAIGenerateContentResponse | undefined,
  startTime?: number,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (startTime) {
    const end = getCurrentUnixTimestamp();
    metrics.duration = end - startTime;
  }

  if (response?.usageMetadata) {
    populateUsageMetrics(metrics, response.usageMetadata);
  }

  return metrics;
}

function populateUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleGenAIUsageMetadata,
): void {
  if (usage.promptTokenCount !== undefined) {
    metrics.prompt_tokens = usage.promptTokenCount;
  }
  if (usage.candidatesTokenCount !== undefined) {
    metrics.completion_tokens = usage.candidatesTokenCount;
  }
  if (usage.totalTokenCount !== undefined) {
    metrics.tokens = usage.totalTokenCount;
  }
  if (usage.cachedContentTokenCount !== undefined) {
    metrics.prompt_cached_tokens = usage.cachedContentTokenCount;
  }
  if (usage.thoughtsTokenCount !== undefined) {
    metrics.completion_reasoning_tokens = usage.thoughtsTokenCount;
  }
}

/**
 * Aggregate chunks from streaming generateContentStream response.
 */
function aggregateGenerateContentChunks(
  chunks: GoogleGenAIGenerateContentResponse[],
  _result?:
    | GoogleGenAIGenerateContentResponse
    | AsyncIterable<GoogleGenAIGenerateContentResponse>,
  _endEvent?: unknown,
  startTime?: number,
): {
  output: Record<string, unknown>;
  metrics: Record<string, number>;
} {
  const metrics: Record<string, number> = {};

  if (startTime !== undefined) {
    const end = getCurrentUnixTimestamp();
    metrics.duration = end - startTime;
  }

  let firstTokenTime: number | null = null;

  if (chunks.length > 0 && firstTokenTime === null && startTime !== undefined) {
    firstTokenTime = getCurrentUnixTimestamp();
    metrics.time_to_first_token = firstTokenTime - startTime;
  }

  if (chunks.length === 0) {
    return { output: {}, metrics };
  }

  let text = "";
  let thoughtText = "";
  const otherParts: Record<string, unknown>[] = [];
  let usageMetadata: GoogleGenAIUsageMetadata | null = null;
  let lastResponse: GoogleGenAIGenerateContentResponse | null = null;

  for (const chunk of chunks) {
    lastResponse = chunk;

    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata;
    }

    if (chunk.candidates && Array.isArray(chunk.candidates)) {
      for (const candidate of chunk.candidates) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined) {
              if (part.thought) {
                thoughtText += part.text;
              } else {
                text += part.text;
              }
            } else if (part.functionCall) {
              otherParts.push({ functionCall: part.functionCall });
            } else if (part.codeExecutionResult) {
              otherParts.push({
                codeExecutionResult: part.codeExecutionResult,
              });
            } else if (part.executableCode) {
              otherParts.push({ executableCode: part.executableCode });
            }
          }
        }
      }
    }
  }

  const output: Record<string, unknown> = {};

  const parts: Record<string, unknown>[] = [];
  if (thoughtText) {
    parts.push({ text: thoughtText, thought: true });
  }
  if (text) {
    parts.push({ text });
  }
  parts.push(...otherParts);

  if (parts.length > 0 && lastResponse?.candidates) {
    const candidates: Record<string, unknown>[] = [];
    for (const candidate of lastResponse.candidates) {
      const candidateDict: Record<string, unknown> = {
        content: {
          parts,
          role: "model",
        },
      };

      if (candidate.finishReason !== undefined) {
        candidateDict.finishReason = candidate.finishReason;
      }
      if (candidate.safetyRatings) {
        candidateDict.safetyRatings = candidate.safetyRatings;
      }

      candidates.push(candidateDict);
    }
    output.candidates = candidates;
  }

  if (usageMetadata) {
    output.usageMetadata = usageMetadata;
    populateUsageMetrics(metrics, usageMetadata);
  }

  if (text) {
    output.text = text;
  }

  return { output, metrics };
}

/**
 * Helper to convert objects to dictionaries.
 */
function tryToDict(obj: unknown): Record<string, unknown> | null {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj === "object") {
    if (
      "toJSON" in obj &&
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      typeof (obj as Record<string, unknown>).toJSON === "function"
    ) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return (obj as { toJSON: () => Record<string, unknown> }).toJSON();
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return obj as Record<string, unknown>;
  }

  return null;
}
