import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import {
  concatUint8Arrays,
  isObject,
  SpanTypeAttribute,
} from "../../../util/index";
import { Attachment, withCurrent, type Span } from "../../logger";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  processInputAttachments,
} from "../../wrappers/attachment-utils";
import { getCurrentUnixTimestamp } from "../../util";
import {
  aggregateChatCompletionChunks,
  parseMetricsFromUsage,
} from "./openai-plugin";
import { groqChannels } from "./groq-channels";
import { observeByteStream } from "../core/stream-patcher";
import type {
  GroqAudioSpeechCreateParams,
  GroqAudioTextResult,
  GroqAudioTranscriptionCreateParams,
  GroqAudioTranslationCreateParams,
  GroqChatCompletion,
  GroqChatCompletionChunk,
} from "../../vendor-sdk-types/groq";

export class GroqPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceStreamingChannel(groqChannels.chatCompletionsCreate, {
        name: "groq.chat.completions.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { messages, ...metadata } = params;
          return {
            input: processInputAttachments(messages),
            metadata: { ...metadata, provider: "groq" },
          };
        },
        extractOutput: (result) => result?.choices,
        extractMetrics: (result, startTime) => {
          const metrics = parseGroqMetrics(result);
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateGroqChatCompletionChunks,
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(groqChannels.embeddingsCreate, {
        name: "groq.embeddings.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input,
            metadata: { ...metadata, provider: "groq" },
          };
        },
        extractOutput: (result) => {
          const embedding = result?.data?.[0]?.embedding;
          return Array.isArray(embedding)
            ? { embedding_length: embedding.length }
            : undefined;
        },
        extractMetrics: (result) => parseGroqMetrics(result),
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(groqChannels.audioSpeechCreate, {
        name: "groq.audio.speech.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => ({
          input: {
            operation: "speech",
            prompt: params.input,
            parameters: {
              voice: params.voice,
              format: params.response_format,
              speed: params.speed,
            },
          },
          metadata: { model: params.model, provider: "groq" },
        }),
        extractOutput: () => ({ content: [] }),
        extractMetrics: () => ({}),
        patchResult: ({ endEvent, result, span, startTime }) =>
          captureGroqSpeechResponse(
            result,
            endEvent.arguments![0],
            span,
            startTime,
          ),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(groqChannels.audioTranscriptionsCreate, {
        name: "groq.audio.transcriptions.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractGroqAudioInput(params, "transcribe"),
        extractOutput: extractGroqAudioTextOutput,
        extractMetrics: (result) => parseGroqMetricsObject(result),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(groqChannels.audioTranslationsCreate, {
        name: "groq.audio.translations.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractGroqAudioInput(params, "translate"),
        extractOutput: extractGroqAudioTextOutput,
        extractMetrics: (result) => parseGroqMetricsObject(result),
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

type GroqAudioTextParams =
  | GroqAudioTranscriptionCreateParams
  | GroqAudioTranslationCreateParams;

function extractGroqAudioInput(
  params: GroqAudioTextParams,
  operation: "transcribe" | "translate",
): { input: unknown; metadata: Record<string, unknown> } {
  const filePart = groqAudioFilePart(params.file ?? params.url);
  return {
    input: {
      operation,
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
      content: filePart ? [filePart] : [],
      parameters: {
        ...(params.language !== undefined ? { language: params.language } : {}),
        ...(params.response_format !== undefined
          ? { format: params.response_format }
          : {}),
        ...("timestamp_granularities" in params &&
        params.timestamp_granularities !== undefined
          ? { timestamp_granularities: params.timestamp_granularities }
          : {}),
      },
    },
    metadata: { model: params.model, provider: "groq" },
  };
}

function groqAudioFilePart(source: unknown): unknown | undefined {
  if (source === undefined || source === null) return undefined;

  if (typeof source === "string") {
    if (source.startsWith("data:")) {
      const contentType = source.match(/^data:([^;,]+)/)?.[1];
      const blob = contentType ? convertDataToBlob(source, contentType) : null;
      if (contentType && blob) {
        const filename = `audio.${getExtensionFromMediaType(contentType)}`;
        return {
          type: "file",
          file: {
            filename,
            file_data: new Attachment({ data: blob, filename, contentType }),
          },
        };
      }
    }

    const filename = filenameFromPath(source) ?? "audio";
    return {
      type: "file",
      file: { filename, file_data: source },
    };
  }

  if (!isObject(source)) return undefined;
  const filename =
    typeof source.name === "string" && source.name
      ? filenameFromPath(source.name)
      : typeof source.path === "string" && source.path
        ? filenameFromPath(source.path)
        : undefined;
  const contentType =
    typeof source.type === "string" && source.type
      ? source.type
      : audioContentTypeFromFilename(filename);
  const data =
    source instanceof Blob
      ? source
      : typeof source.path === "string"
        ? source.path
        : undefined;

  if (!filename || !contentType || data === undefined) return undefined;
  return {
    type: "file",
    file: {
      filename,
      file_data: new Attachment({ data, filename, contentType }),
    },
  };
}

function filenameFromPath(value: string): string | undefined {
  const withoutQuery = value.split(/[?#]/, 1)[0];
  return withoutQuery.split(/[\\/]/).pop() || undefined;
}

function audioContentTypeFromFilename(filename: string | undefined) {
  const extension = filename?.split(".").pop()?.toLowerCase();
  return extension
    ? {
        flac: "audio/flac",
        m4a: "audio/mp4",
        mp3: "audio/mpeg",
        mp4: "audio/mp4",
        mpeg: "audio/mpeg",
        mpga: "audio/mpeg",
        ogg: "audio/ogg",
        wav: "audio/wav",
        webm: "audio/webm",
      }[extension]
    : undefined;
}

function extractGroqAudioTextOutput(result: GroqAudioTextResult | string) {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }

  const annotations = {
    ...(typeof result?.language === "string"
      ? { language: result.language }
      : {}),
    ...(typeof result?.duration === "number"
      ? { duration: result.duration }
      : {}),
    ...(Array.isArray(result?.segments) ? { segments: result.segments } : {}),
    ...(Array.isArray(result?.words) ? { words: result.words } : {}),
  };
  return {
    content:
      typeof result?.text === "string"
        ? [{ type: "text", text: result.text }]
        : [],
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

function parseGroqMetricsObject(result: unknown): Record<string, number> {
  return isObject(result) ? parseGroqMetrics(result) : {};
}

function captureGroqSpeechResponse(
  response: Response,
  request: GroqAudioSpeechCreateParams,
  span: Span,
  startTime: number,
): boolean {
  if (!isObject(response)) return false;

  const headerContentType =
    isObject(response.headers) && typeof response.headers.get === "function"
      ? response.headers.get("content-type")?.split(";", 1)[0]
      : undefined;
  const contentType = headerContentType?.startsWith("audio/")
    ? headerContentType
    : audioContentTypeFromFormat(request.response_format ?? "wav");
  if (!contentType) return false;

  const filename = `speech.${getExtensionFromMediaType(contentType)}`;
  const chunks: Uint8Array[] = [];
  let finished = false;
  let firstChunk = true;
  const onChunk = (chunk: Uint8Array) => {
    if (finished || chunk.byteLength === 0) return;
    if (firstChunk) {
      span.log({
        metrics: {
          time_to_first_token: getCurrentUnixTimestamp() - startTime,
        },
      });
      firstChunk = false;
    }
    chunks.push(new Uint8Array(chunk));
  };
  const complete = () => {
    if (finished) return;
    finished = true;
    const data = concatUint8Arrays(...chunks);
    chunks.length = 0;
    span.log({
      output: {
        content:
          data.byteLength > 0
            ? [
                {
                  type: "file",
                  file: {
                    filename,
                    byte_size: data.byteLength,
                    file_data: new Attachment({
                      data: data.buffer,
                      filename,
                      contentType,
                    }),
                  },
                },
              ]
            : [],
      },
    });
    span.end();
  };
  const cancel = (error?: unknown) => {
    if (finished) return;
    finished = true;
    chunks.length = 0;
    if (error !== undefined) span.log({ error });
    span.end();
  };

  if (isObject(response.body)) {
    observeByteStream(response.body, {
      onChunk,
      onComplete: complete,
      onCancel: cancel,
      aroundRead: (next) => withCurrent(span, next),
      debugLabel: "Groq speech audio",
    });
  }

  let patched = isObject(response.body);
  patched =
    patchResponseBytesMethod(
      response,
      "arrayBuffer",
      onChunk,
      complete,
      cancel,
    ) || patched;
  patched =
    patchResponseBytesMethod(response, "bytes", onChunk, complete, cancel) ||
    patched;
  patched =
    patchResponseBlobMethod(response, onChunk, complete, cancel) || patched;
  return patched;
}

function patchResponseBytesMethod(
  response: object,
  method: "arrayBuffer" | "bytes",
  onChunk: (chunk: Uint8Array) => void,
  complete: () => void,
  cancel: (error?: unknown) => void,
): boolean {
  const responseRecord = response as Record<string, unknown>;
  const original = responseRecord[method];
  if (!Object.isExtensible(response) || typeof original !== "function")
    return false;
  responseRecord[method] = function (this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    void Promise.resolve(result).then((value) => {
      if (value instanceof ArrayBuffer) onChunk(new Uint8Array(value));
      else if (value instanceof Uint8Array) onChunk(value);
      complete();
    }, cancel);
    return result;
  };
  return true;
}

function patchResponseBlobMethod(
  response: object,
  onChunk: (chunk: Uint8Array) => void,
  complete: () => void,
  cancel: (error?: unknown) => void,
): boolean {
  const responseRecord = response as Record<string, unknown>;
  const original = responseRecord.blob;
  if (!Object.isExtensible(response) || typeof original !== "function")
    return false;
  responseRecord.blob = function (this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    void Promise.resolve(result).then((value) => {
      if (!(value instanceof Blob)) {
        complete();
        return;
      }
      void value.arrayBuffer().then((bytes) => {
        onChunk(new Uint8Array(bytes));
        complete();
      }, cancel);
    }, cancel);
    return result;
  };
  return true;
}

function audioContentTypeFromFormat(format: string): string | undefined {
  return {
    flac: "audio/flac",
    mp3: "audio/mpeg",
    mulaw: "audio/basic",
    ogg: "audio/ogg",
    wav: "audio/wav",
  }[format.toLowerCase()];
}

export function parseGroqMetrics(
  result:
    | Pick<GroqChatCompletion, "usage" | "x_groq">
    | { usage?: unknown; x_groq?: unknown }
    | null
    | undefined,
): Record<string, number> {
  const metrics = parseMetricsFromUsage(result?.usage);
  const xGroq = result?.x_groq;

  if (!xGroq || typeof xGroq !== "object") {
    return metrics;
  }

  const extraUsage = "usage" in xGroq ? xGroq.usage : undefined;

  if (!extraUsage || typeof extraUsage !== "object") {
    return metrics;
  }

  const dramCachedTokens = (extraUsage as Record<string, unknown>)[
    "dram_cached_tokens"
  ];
  const sramCachedTokens = (extraUsage as Record<string, unknown>)[
    "sram_cached_tokens"
  ];

  return {
    ...metrics,
    ...(typeof dramCachedTokens === "number"
      ? { dram_cached_tokens: dramCachedTokens }
      : {}),
    ...(typeof sramCachedTokens === "number"
      ? { sram_cached_tokens: sramCachedTokens }
      : {}),
  };
}

export function aggregateGroqChatCompletionChunks(
  chunks: GroqChatCompletionChunk[],
  streamResult?: unknown,
  endEvent?: unknown,
): {
  metrics: Record<string, number>;
  output: GroqChatCompletion["choices"];
} {
  const aggregated = aggregateChatCompletionChunks(
    chunks,
    streamResult,
    endEvent,
  );
  const reasoning = aggregateGroqReasoning(chunks);
  if (reasoning !== undefined) {
    const message = aggregated.output[0]?.message;
    if (message) {
      message.reasoning = reasoning;
    }
  }
  return {
    metrics: aggregated.metrics,
    output: aggregated.output,
  };
}

function aggregateGroqReasoning(
  chunks: GroqChatCompletionChunk[],
): string | undefined {
  let reasoning = "";

  for (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta;
    const deltaReasoning = delta?.reasoning;
    if (typeof deltaReasoning === "string") {
      reasoning += deltaReasoning;
    }
  }

  return reasoning.length > 0 ? reasoning : undefined;
}
