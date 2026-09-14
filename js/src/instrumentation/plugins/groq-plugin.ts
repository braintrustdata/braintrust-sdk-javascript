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
import { isAsyncIterable, observeByteStream } from "../core/stream-patcher";
import { debugLogger } from "../../debug-logger";
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
        extractInput: ([params], _event, span) =>
          extractGroqAudioInput(params, "transcribe", span),
        extractOutput: extractGroqAudioTextOutput,
        extractMetrics: (result) => parseGroqMetricsObject(result),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(groqChannels.audioTranslationsCreate, {
        name: "groq.audio.translations.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], _event, span) =>
          extractGroqAudioInput(params, "translate", span),
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
  span: Span,
): { input: unknown; metadata: Record<string, unknown> } {
  const source = params.file ?? params.url;
  const filePart = groqAudioFilePart(source);
  const input = {
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
  };
  if (!filePart) observeGroqAudioInput(source, input, span);
  return {
    input,
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
  const data = source instanceof Blob ? source : undefined;

  if (!contentType || data === undefined) return undefined;
  const resolvedFilename =
    filename ?? `audio.${getExtensionFromMediaType(contentType)}`;
  return {
    type: "file",
    file: {
      filename: resolvedFilename,
      file_data: new Attachment({
        data,
        filename: resolvedFilename,
        contentType,
      }),
    },
  };
}

function observeGroqAudioInput(
  source: unknown,
  input: Record<string, unknown>,
  span: Span,
): void {
  if (!isObject(source)) return;

  const body = isObject(source.body)
    ? source.body
    : isAsyncIterable(source)
      ? source
      : undefined;
  if (!body) return;

  const contentType =
    responseHeader(source, "content-type")?.split(";", 1)[0]?.trim() ||
    (typeof source.type === "string" && source.type
      ? source.type
      : audioContentTypeFromFilename(filenameForAudioSource(source)));
  if (!contentType) return;

  const filename =
    filenameFromContentDisposition(
      responseHeader(source, "content-disposition"),
    ) ??
    filenameForAudioSource(source) ??
    `audio.${getExtensionFromMediaType(contentType)}`;
  const chunks: Uint8Array[] = [];
  let finished = false;
  const observer: Parameters<typeof observeByteStream>[1] = {
    onChunk(chunk: Uint8Array) {
      if (!finished && chunk.byteLength > 0) chunks.push(new Uint8Array(chunk));
    },
    onComplete() {
      if (finished) return;
      finished = true;
      const data = concatUint8Arrays(...chunks);
      chunks.length = 0;
      if (data.byteLength === 0) return;
      span.log({
        input: {
          ...input,
          content: [
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
          ],
        },
      });
    },
    onCancel() {
      finished = true;
      chunks.length = 0;
    },
    aroundRead: (next) => withCurrent(span, next),
    debugLabel: "Groq input audio",
  };

  if (body === source) observeByteStream(body, observer);
  else observeResponseBytes(source, observer);
}

function filenameForAudioSource(source: Record<string, unknown>) {
  if (typeof source.name === "string" && source.name)
    return filenameFromPath(source.name);
  if (typeof source.path === "string" && source.path)
    return filenameFromPath(source.path);
  if (typeof source.url === "string" && source.url)
    return filenameFromPath(source.url);
  return undefined;
}

function responseHeader(
  response: Record<string, unknown>,
  name: string,
): string | undefined {
  if (!isObject(response.headers) || typeof response.headers.get !== "function")
    return undefined;
  try {
    const value = Reflect.apply(response.headers.get, response.headers, [name]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function filenameFromContentDisposition(value: string | undefined) {
  const match = value?.match(/filename="([^"]+)"|filename=([^;]+)/i);
  return match?.[1] ?? match?.[2]?.trim();
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

  const headerContentType = responseHeader(response, "content-type")?.split(
    ";",
    1,
  )[0];
  const contentType = headerContentType?.startsWith("audio/")
    ? headerContentType
    : audioContentTypeFromFormat(request.response_format ?? "wav");
  if (!contentType) return false;

  const filename =
    filenameFromContentDisposition(
      responseHeader(response, "content-disposition"),
    ) ?? `speech.${getExtensionFromMediaType(contentType)}`;
  const chunks: Uint8Array[] = [];
  let finished = false;
  let started = false;
  let spanEnded = false;
  const endSpan = () => {
    if (spanEnded) return;
    spanEnded = true;
    try {
      span.end();
    } catch (error) {
      debugLogger.error("Error ending Groq speech span", error);
    }
  };
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
    try {
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
    } finally {
      endSpan();
    }
  };
  const cancel = (error?: unknown) => {
    if (finished) return;
    finished = true;
    chunks.length = 0;
    try {
      if (error !== undefined) span.log({ error });
    } finally {
      endSpan();
    }
  };

  const patched = observeResponseBytes(response, {
    onChunk,
    onComplete: complete,
    onCancel: cancel,
    onStart: () => {
      started = true;
    },
    aroundRead: (next) => withCurrent(span, next),
    debugLabel: "Groq speech audio",
  });
  if (patched)
    queueMicrotask(() => {
      if (!started) {
        try {
          span.log({ output: { content: [] } });
        } catch (error) {
          debugLogger.error("Error logging unread Groq speech response", error);
        } finally {
          endSpan();
        }
      }
    });
  return patched;
}

function observeResponseBytes(
  response: Record<string, unknown>,
  options: Parameters<typeof observeByteStream>[1],
): boolean {
  const onStart = options.onStart;
  const safely = (callback: () => void) => {
    try {
      callback();
    } catch (error) {
      debugLogger.error(`Error observing ${options.debugLabel}`, error);
    }
  };
  const safeOptions: Parameters<typeof observeByteStream>[1] = {
    ...options,
    onStart: onStart
      ? () => {
          safely(onStart);
        }
      : undefined,
    onChunk: (chunk) => safely(() => options.onChunk(chunk)),
    onComplete: () => safely(options.onComplete),
    onCancel: (error) => safely(() => options.onCancel(error)),
  };
  let patched = false;
  if (isObject(response.body)) {
    observeByteStream(response.body, safeOptions);
    patched = true;
  }

  patched =
    patchResponseBytesMethod(response, "arrayBuffer", safeOptions) || patched;
  patched = patchResponseBytesMethod(response, "bytes", safeOptions) || patched;
  patched = patchResponseBlobMethod(response, safeOptions) || patched;
  for (const method of ["formData", "json", "text"] as const)
    patched =
      patchResponseCompletionMethod(response, method, safeOptions) || patched;
  patched = patchResponseCloneMethod(response, safeOptions) || patched;
  return patched;
}

function patchResponseBytesMethod(
  response: object,
  method: "arrayBuffer" | "bytes",
  options: Parameters<typeof observeByteStream>[1],
): boolean {
  const responseRecord = response as Record<string, unknown>;
  const original = responseRecord[method];
  if (!Object.isExtensible(response) || typeof original !== "function")
    return false;
  responseRecord[method] = function (this: unknown, ...args: unknown[]) {
    options.onStart?.();
    let result: unknown;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      options.onCancel(error);
      throw error;
    }
    void Promise.resolve(result).then((value) => {
      if (value instanceof ArrayBuffer) options.onChunk(new Uint8Array(value));
      else if (value instanceof Uint8Array) options.onChunk(value);
      options.onComplete();
    }, options.onCancel);
    return result;
  };
  return true;
}

function patchResponseBlobMethod(
  response: object,
  options: Parameters<typeof observeByteStream>[1],
): boolean {
  const responseRecord = response as Record<string, unknown>;
  const original = responseRecord.blob;
  if (!Object.isExtensible(response) || typeof original !== "function")
    return false;
  responseRecord.blob = function (this: unknown, ...args: unknown[]) {
    options.onStart?.();
    let result: unknown;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      options.onCancel(error);
      throw error;
    }
    void Promise.resolve(result).then((value) => {
      if (!(value instanceof Blob)) {
        options.onComplete();
        return;
      }
      void value.arrayBuffer().then((bytes) => {
        options.onChunk(new Uint8Array(bytes));
        options.onComplete();
      }, options.onCancel);
    }, options.onCancel);
    return result;
  };
  return true;
}

function patchResponseCompletionMethod(
  response: object,
  method: "formData" | "json" | "text",
  options: Parameters<typeof observeByteStream>[1],
): boolean {
  const responseRecord = response as Record<string, unknown>;
  const original = responseRecord[method];
  if (!Object.isExtensible(response) || typeof original !== "function")
    return false;
  responseRecord[method] = function (this: unknown, ...args: unknown[]) {
    options.onStart?.();
    let result: unknown;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      options.onCancel(error);
      throw error;
    }
    void Promise.resolve(result).then(
      () => options.onCancel(),
      options.onCancel,
    );
    return result;
  };
  return true;
}

function patchResponseCloneMethod(
  response: object,
  options: Parameters<typeof observeByteStream>[1],
): boolean {
  const responseRecord = response as Record<string, unknown>;
  const original = responseRecord.clone;
  if (!Object.isExtensible(response) || typeof original !== "function")
    return false;
  responseRecord.clone = function (this: unknown, ...args: unknown[]) {
    const clone = Reflect.apply(original, this, args);
    if (isObject(clone)) observeResponseBytes(clone, options);
    return clone;
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
