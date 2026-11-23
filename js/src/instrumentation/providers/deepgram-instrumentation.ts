import { isObject, SpanTypeAttribute } from "../../../util";
import { debugLogger } from "../../debug-logger";
import {
  Attachment,
  startSpan,
  withCurrent,
  type Span,
} from "../../logger/core";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type {
  DeepgramRequest,
  DeepgramRequestOptions,
  DeepgramResponse,
  DeepgramLegacyResponse,
  DeepgramAudio,
  DeepgramLegacyAudio,
} from "../../vendor-sdk-types/deepgram";
import {
  getExtensionFromMediaType,
  isAutoCaptureAttachmentsEnabled,
  isEnvFlagEnabled,
} from "../../wrappers/attachment-utils";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { observeResult, runInstrumentation } from "../core/observe-result";
import { observeByteStream } from "../core/stream-patcher";
import { deepgramChannels } from "./deepgram-interceptors";

export function registerDeepgramInstrumentation(): void {
  for (const [key, hook] of Object.entries(deepgramChannels)) {
    hook.intercept((target, receiver, args) =>
      traceDeepgramCall(
        () => Reflect.apply(target, receiver, args),
        () => {
          const legacy = key.startsWith("legacy");
          const file =
            key === "transcribeFile" || key === "legacyTranscribeFile";
          const request = ((legacy || file ? args[1] : args[0]) ??
            {}) as DeepgramRequest;
          const options = (legacy ? undefined : args[file ? 2 : 1]) as
            | DeepgramRequestOptions
            | undefined;
          const source = args[0] as DeepgramRequest;
          return {
            name: `deepgram.${hook.channelName}`,
            operation: hook.channelName.startsWith("listen.")
              ? "transcribe"
              : hook.channelName.startsWith("speak.")
                ? "speech"
                : "analyze",
            legacy,
            request,
            source: file ? source : legacy ? source : (request.body ?? request),
            file,
            // A transport override can add a callback even when the request
            // has an empty callback field. Neither callback_method nor
            // speak.v2 priority starts background work without a callback.
            callback:
              request.callback ||
              options?.queryParams?.callback ||
              (legacy &&
                typeof args[2] === "string" &&
                new URL(args[2], "https://api.deepgram.com").searchParams
                  .getAll("callback")
                  .some(Boolean)),
          };
        },
      ),
    );
  }
}

interface CallInfo {
  name: string;
  operation: "transcribe" | "speech" | "analyze";
  legacy: boolean;
  request: DeepgramRequest;
  source: unknown;
  file: boolean;
  callback: unknown;
}
type Finish = (error?: unknown) => void;

function traceDeepgramCall<T>(call: () => T, describe: () => CallInfo): T {
  if (isAutoInstrumentationSuppressed()) return call();
  let info: CallInfo;
  try {
    info = describe();
  } catch (error) {
    debugLogger.error("Error reading Deepgram request", error);
    return call();
  }
  if (info.callback) return call();
  const { request, source, operation } = info;
  const captureInput =
    isAutoCaptureAttachmentsEnabled() &&
    isEnvFlagEnabled("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS");
  const captureOutput =
    isAutoCaptureAttachmentsEnabled() &&
    isEnvFlagEnabled("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS");
  const started = Date.now() / 1000;
  const span = startSpan(
    withSpanInstrumentationName(
      {
        name: info.name,
        spanAttributes: { type: SpanTypeAttribute.LLM },
      },
      INSTRUMENTATION_NAMES.DEEPGRAM,
    ),
  );
  let ended = false;
  const finish: Finish = (error) => {
    if (ended) return;
    ended = true;
    if (error !== undefined) span.log({ error });
    span.end();
  };
  runInstrumentation(() => {
    const content = [];
    if (!info.file && isObject(source)) {
      if (typeof source.text === "string")
        content.push({ type: "text", text: source.text });
      if (typeof source.url === "string" && /^https?:\/\//i.test(source.url))
        content.push({
          type: "file",
          file: { filename: "media", file_data: source.url },
        });
    }
    span.log({
      input: {
        operation,
        ...(operation === "speech" && isObject(source)
          ? { prompt: source.text }
          : { content }),
        parameters:
          operation === "speech"
            ? {
                format: request.container ?? request.encoding,
                speed: request.speed,
                language: request.language,
              }
            : { language: request.language },
      },
      // Deepgram-specific metadata allowlist. Never copy request options or
      // provider metadata wholesale (they can contain credentials and user data).
      metadata: {
        provider: "deepgram",
        model: request.model,
        encoding: request.encoding,
        container: request.container,
        sample_rate: request.sample_rate,
        bit_rate: request.bit_rate,
        sentiment: request.sentiment,
        topics: request.topics,
        intents: request.intents,
        summarize: request.summarize,
        diarize: request.diarize,
        smart_format: request.smart_format,
        punctuate: request.punctuate,
      },
    });
    if (info.file && captureInput) captureFile(source, span);
  });
  let result: T;
  try {
    result = withCurrent(span, () =>
      runWithAutoInstrumentationSuppressed(call),
    );
  } catch (error) {
    finish(error);
    throw error;
  }
  const capture = (value: unknown, headers?: Headers) => {
    try {
      if (operation === "speech") {
        span.log({
          output: { content: [] },
          metadata: {
            model: headers?.get("dg-model-name") ?? request.model,
            request_id: headers?.get("dg-request-id"),
          },
        });
        if (captureOutput) {
          captureSpeech(
            value as DeepgramAudio | DeepgramLegacyAudio,
            info,
            span,
            finish,
            started,
            headers,
          );
          return;
        }
        if (info.legacy) {
          observeResult(
            (value as DeepgramLegacyAudio).getHeaders(),
            (headers) => {
              span.log({
                metadata: {
                  model: headers.get("dg-model-name") ?? request.model,
                  request_id: headers.get("dg-request-id"),
                },
              });
            },
            () => {},
          );
        }
      } else {
        const response = info.legacy
          ? (value as DeepgramLegacyResponse).result
          : (value as DeepgramResponse);
        const error = info.legacy
          ? (value as DeepgramLegacyResponse).error
          : undefined;
        if (error) {
          finish(error);
          return;
        }
        if (response) {
          const results = response.results;
          const metadata = response.metadata;
          const usage = [
            metadata?.summary_info,
            metadata?.sentiment_info,
            metadata?.topics_info,
            metadata?.intents_info,
          ].filter((info) => info !== undefined);
          const inputTokens = usage.filter(
            (info) => typeof info?.input_tokens === "number",
          );
          const outputTokens = usage.filter(
            (info) => typeof info?.output_tokens === "number",
          );
          const promptTokens = inputTokens.reduce(
            (sum, info) => sum + info!.input_tokens!,
            0,
          );
          const completionTokens = outputTokens.reduce(
            (sum, info) => sum + info!.output_tokens!,
            0,
          );
          const channels = results?.channels ?? [];
          const alternatives = channels.flatMap(
            (channel) => channel.alternatives?.slice(0, 1) ?? [],
          );
          span.log({
            output:
              operation === "transcribe"
                ? {
                    content: [
                      {
                        type: "text",
                        text: alternatives
                          .map((alternative) => alternative.transcript ?? "")
                          .join("\n"),
                      },
                    ],
                    annotations: {
                      language: channels[0]?.detected_language,
                      duration: metadata?.duration,
                      segments: results?.utterances,
                      words: alternatives.flatMap(
                        (alternative) => alternative.words ?? [],
                      ),
                    },
                  }
                : {
                    content: results?.summary?.text
                      ? [{ type: "text", text: results.summary.text }]
                      : [],
                    annotations: {
                      summary: results?.summary,
                      sentiments: results?.sentiments,
                      topics: results?.topics,
                      intents: results?.intents,
                    },
                  },
            metadata: {
              request_id: metadata?.request_id,
              model:
                Object.values(metadata?.model_info ?? {})[0]?.name ??
                usage[0]?.model_uuid ??
                request.model,
            },
            metrics: {
              ...(inputTokens.length ? { prompt_tokens: promptTokens } : {}),
              ...(outputTokens.length
                ? { completion_tokens: completionTokens }
                : {}),
              ...(inputTokens.length && outputTokens.length
                ? { tokens: promptTokens + completionTokens }
                : {}),
            },
          });
        }
      }
    } catch (error) {
      debugLogger.error("Error capturing Deepgram response", error);
    }
    finish();
  };
  // HttpResponsePromise exposes the same execution's headers without consuming
  // its binary response. Observe this path before callers use either helper.
  if (isObject(result) && typeof result.withRawResponse === "function") {
    const withRawResponse = result.withRawResponse;
    runInstrumentation(() =>
      observeResult(
        withRawResponse.call(result) as Promise<{
          data: unknown;
          rawResponse: { headers?: Headers };
        }>,
        ({ data, rawResponse }) => capture(data, rawResponse.headers),
        finish,
      ),
    );
  } else observeResult(result, capture, finish);
  return result;
}

function captureFile(source: unknown, span: Span): void {
  const contentType =
    source instanceof Blob && source.type
      ? source.type
      : "application/octet-stream";
  const filename =
    typeof File !== "undefined" && source instanceof File
      ? source.name
      : "media";
  const log = (data: Blob) =>
    span.log({
      input: {
        content: [
          {
            type: "file",
            file: {
              filename,
              file_data: new Attachment({ data, filename, contentType }),
            },
          },
        ],
      },
    });
  if (source instanceof Blob) log(source);
  else if (source instanceof Uint8Array)
    log(new Blob([new Uint8Array(source)], { type: contentType }));
  else if (source instanceof ArrayBuffer)
    log(new Blob([source.slice(0)], { type: contentType }));
  else {
    const chunks: Uint8Array[] = [];
    observeByteStream(source, {
      onChunk: (chunk) => chunks.push(new Uint8Array(chunk)),
      onComplete: () => {
        log(new Blob(chunks as BlobPart[], { type: contentType }));
        chunks.length = 0;
      },
      onCancel: () => {
        chunks.length = 0;
      },
      aroundRead: (next) => withCurrent(span, next),
      debugLabel: "Deepgram input media",
    });
  }
}

function captureSpeech(
  value: DeepgramAudio | DeepgramLegacyAudio,
  info: CallInfo,
  span: Span,
  finish: Finish,
  started: number,
  headers?: Headers,
): void {
  const {
    encoding = "linear16",
    container = encoding === "linear16" ? "wav" : undefined,
  } = info.request;
  const fallbackType =
    container === "wav"
      ? "audio/wav"
      : container === "ogg"
        ? "audio/ogg"
        : encoding === "mp3"
          ? "audio/mpeg"
          : encoding === "flac"
            ? "audio/flac"
            : encoding === "mulaw"
              ? "audio/basic"
              : encoding === "alaw"
                ? "audio/x-alaw"
                : encoding === "linear16"
                  ? "audio/pcm"
                  : undefined;
  let completed = false;
  const chunks: Uint8Array[] = [];
  const complete = (data: Blob) => {
    if (completed) return;
    completed = true;
    chunks.length = 0;
    const contentType =
      headers?.get("content-type")?.split(";")[0] || data.type || fallbackType;
    if (!contentType) {
      finish();
      return;
    }
    const disposition = headers?.get("content-disposition");
    const filename =
      disposition
        ?.match(/filename="([^"]+)"|filename=([^;]+)/i)
        ?.slice(1)
        .find(Boolean)
        ?.trim() ?? `speech.${getExtensionFromMediaType(contentType)}`;
    span.log({
      output: {
        content: [
          {
            type: "file",
            file: {
              filename,
              byte_size: data.size,
              file_data: new Attachment({ data, filename, contentType }),
            },
          },
        ],
      },
    });
    finish();
  };
  const cancel: Finish = (error) => {
    if (completed) return;
    completed = true;
    chunks.length = 0;
    finish(error);
  };
  const stream = (body: unknown) => {
    if (!body) {
      cancel();
      return;
    }
    observeByteStream(body, {
      onChunk: (chunk) => {
        if (completed || !chunk.byteLength) return;
        if (!chunks.length)
          span.log({
            metrics: { time_to_first_token: Date.now() / 1000 - started },
          });
        chunks.push(new Uint8Array(chunk));
      },
      onComplete: () =>
        complete(new Blob(chunks as BlobPart[], { type: fallbackType })),
      onCancel: cancel,
      aroundRead: (next) => withCurrent(span, next),
      debugLabel: "Deepgram output audio",
    });
  };
  if (info.legacy) {
    observeResult(
      (value as DeepgramLegacyAudio).getHeaders(),
      (value) => {
        headers = value;
        span.log({
          metadata: {
            model: headers.get("dg-model-name") ?? info.request.model,
            request_id: headers.get("dg-request-id"),
          },
        });
      },
      () => {},
    );
    // getStream only retrieves the body; it does not start reading it.
    observeResult((value as DeepgramLegacyAudio).getStream(), stream, cancel);
  } else {
    const audio = value as DeepgramAudio;
    stream(audio.stream());
    // BinaryResponse also supports whole-body consumers that bypass getReader.
    // Observe their promises without changing response, promise, or byte identity.
    for (const method of ["arrayBuffer", "blob", "bytes"] as const) {
      const original = audio[method];
      if (!original) continue;
      Object.defineProperty(audio, method, {
        configurable: true,
        writable: true,
        value: function (this: DeepgramAudio, ...args: unknown[]) {
          let result: Promise<ArrayBuffer | Blob | Uint8Array>;
          try {
            result = withCurrent(span, () =>
              Reflect.apply(original, this, args),
            );
          } catch (error) {
            cancel(error);
            throw error;
          }
          return observeResult(
            result,
            (data) =>
              complete(
                data instanceof Blob
                  ? data
                  : new Blob(
                      [
                        data instanceof Uint8Array
                          ? new Uint8Array(data)
                          : data,
                      ],
                      { type: fallbackType },
                    ),
              ),
            cancel,
          );
        },
      });
    }
  }
}
