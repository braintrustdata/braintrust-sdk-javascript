import { isObject, SpanTypeAttribute } from "../../../util";
import { debugLogger } from "../../debug-logger";
import { Attachment, startSpan, withCurrent, type Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type {
  ElevenLabsSpeechArgs,
  ElevenLabsSpeechRequest,
  ElevenLabsTimestampAudio,
  ElevenLabsTranscription,
  ElevenLabsTranscriptionRequest,
} from "../../vendor-sdk-types/elevenlabs";
import { getExtensionFromMediaType } from "../../wrappers/attachment-utils";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import {
  isAsyncIterable,
  observeByteStream,
  patchStreamIfNeeded,
} from "../core/stream-patcher";
import { elevenLabsChannels } from "./elevenlabs-channels";

export class ElevenLabsPlugin extends BasePlugin {
  protected onEnable(): void {
    for (const method of [
      "convert",
      "stream",
      "convertWithTimestamps",
      "streamWithTimestamps",
    ] as const) {
      this.unsubscribers.push(
        interceptCall<ElevenLabsSpeechArgs>(
          elevenLabsChannels[method],
          `elevenlabs.textToSpeech.${method}`,
          ([voice, request]) => ({
            input: {
              operation: "speech",
              prompt: request.text,
              parameters: {
                voice,
                format: request.outputFormat,
                language: request.languageCode,
                speed: request.voiceSettings?.speed,
              },
            },
            metadata: {
              provider: "elevenlabs",
              model: request.modelId ?? "eleven_multilingual_v2",
            },
          }),
          (value, args, span, finish, headers, started) =>
            captureSpeech(
              value,
              args[1],
              method,
              span,
              finish,
              started,
              headers,
            ),
        ),
      );
    }
    this.unsubscribers.push(
      interceptCall<[ElevenLabsTranscriptionRequest, unknown?]>(
        elevenLabsChannels.transcribe,
        "elevenlabs.speechToText.convert",
        ([request]) => {
          // Webhook requests return an acknowledgement; the transcription arrives
          // separately and cannot be captured by this request/response span.
          if (request.webhook) return undefined;
          const file = request.file;
          const filename =
            typeof File !== "undefined" && file instanceof File
              ? file.name
              : "audio";
          const contentType =
            file instanceof Blob
              ? file.type || "application/octet-stream"
              : "application/octet-stream";
          const blob =
            file instanceof Blob
              ? file
              : file instanceof Uint8Array
                ? new Blob([new Uint8Array(file)], { type: contentType })
                : file instanceof ArrayBuffer
                  ? new Blob([file.slice(0)], { type: contentType })
                  : undefined;
          const fileData = blob
            ? new Attachment({ data: blob, filename, contentType })
            : request.cloudStorageUrl;
          return {
            input: {
              operation: "transcribe",
              content: fileData
                ? [{ type: "file", file: { filename, file_data: fileData } }]
                : [],
              parameters: {
                language: request.languageCode,
                timestamp_granularities: request.timestampsGranularity,
              },
            },
            metadata: { provider: "elevenlabs", model: request.modelId },
          };
        },
        (value, _args, span, finish) => {
          const result = value as ElevenLabsTranscription;
          const transcripts = result.transcripts ?? [result];
          span.log({
            output: {
              content: transcripts.flatMap((transcript) =>
                typeof transcript.text === "string"
                  ? [{ type: "text", text: transcript.text }]
                  : [],
              ),
              annotations: {
                language: result.languageCode,
                words:
                  result.words ??
                  (result.transcripts
                    ? result.transcripts.flatMap(
                        (transcript) => transcript.words ?? [],
                      )
                    : undefined),
              },
            },
          });
          finish();
        },
        ([request], span) => {
          const file = request.file;
          if (!isAsyncIterable(file)) return;
          const chunks: Uint8Array[] = [];
          const filename =
            isObject(file) && typeof file.path === "string"
              ? file.path.split(/[\\/]/).pop() || "audio"
              : "audio";
          observeByteStream(file, {
            onChunk: (chunk) => chunks.push(new Uint8Array(chunk)),
            onComplete: () => {
              const contentType = "application/octet-stream";
              const data = new Blob(chunks as BlobPart[], {
                type: contentType,
              });
              chunks.length = 0;
              span.log({
                input: {
                  content: [
                    {
                      type: "file",
                      file: {
                        filename,
                        file_data: new Attachment({
                          data,
                          filename,
                          contentType,
                        }),
                      },
                    },
                  ],
                },
              });
            },
            onCancel: () => {
              chunks.length = 0;
            },
            aroundRead: (next) => withCurrent(span, next),
            debugLabel: "ElevenLabs audio",
          });
        },
      ),
    );
  }
  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

type Finish = (error?: unknown) => void;
type CallChannel<Args extends unknown[]> = {
  intercept(
    callback: (
      target: (...args: Args) => PromiseLike<unknown>,
      self: unknown,
      args: Args,
    ) => PromiseLike<unknown>,
  ): () => void;
};

function interceptCall<Args extends unknown[]>(
  channel: CallChannel<Args>,
  name: string,
  input: (
    args: Args,
  ) => { input: unknown; metadata: Record<string, unknown> } | undefined,
  output: (
    value: unknown,
    args: Args,
    span: Span,
    finish: Finish,
    headers: Headers | undefined,
    started: number,
  ) => void,
  beforeInvoke?: (args: Args, span: Span) => void,
): () => void {
  return channel.intercept((target, self, args) => {
    const invoke = () => Reflect.apply(target, self, args);
    if (isAutoInstrumentationSuppressed()) return invoke();
    const started = Date.now() / 1000;
    let span: Span | undefined;
    try {
      const event = input(args);
      if (event !== undefined)
        span = startSpan(
          withSpanInstrumentationName(
            {
              name,
              spanAttributes: { type: SpanTypeAttribute.LLM },
              event,
            },
            INSTRUMENTATION_NAMES.ELEVENLABS,
          ),
        );
    } catch (error) {
      debugLogger.error("Error starting ElevenLabs span", error);
      return invoke();
    }
    if (!span) return invoke();
    const activeSpan = span;
    let ended = false;
    const finish: Finish = (error) => {
      if (ended) return;
      ended = true;
      try {
        if (error !== undefined) activeSpan.log({ error });
        activeSpan.end();
      } catch (loggingError) {
        debugLogger.error("Error ending ElevenLabs span", loggingError);
      }
    };
    try {
      beforeInvoke?.(args, span);
    } catch (error) {
      debugLogger.error("Error observing ElevenLabs input", error);
    }
    let result: PromiseLike<unknown>;
    try {
      result = withCurrent(span, () =>
        runWithAutoInstrumentationSuppressed(invoke),
      );
    } catch (error) {
      finish(error);
      throw error;
    }
    // Observe the SDK promise without replacing it: withRawResponse() must remain
    // available, including when it is the application's only consumption path.
    const capture = (value: unknown, headers?: Headers) => {
      try {
        output(value, args, span, finish, headers, started);
      } catch (error) {
        debugLogger.error("Error capturing ElevenLabs output", error);
        finish();
      }
    };
    try {
      if (isObject(result) && typeof result.withRawResponse === "function") {
        void result
          .withRawResponse()
          .then(
            ({
              data,
              rawResponse,
            }: {
              data: unknown;
              rawResponse?: { headers?: Headers };
            }) => capture(data, rawResponse?.headers),
            finish,
          );
      } else {
        void Promise.resolve(result).then((value) => capture(value), finish);
      }
    } catch (error) {
      debugLogger.error("Error observing ElevenLabs result", error);
      finish();
    }
    return result;
  });
}

function captureSpeech(
  value: unknown,
  request: ElevenLabsSpeechRequest,
  method: string,
  span: Span,
  finish: Finish,
  started: number,
  headers?: Headers,
): void {
  const format = request.outputFormat ?? "mp3_44100_128";
  const formatType = format.startsWith("mp3_")
    ? "audio/mpeg"
    : format.startsWith("pcm_")
      ? "audio/pcm"
      : format.startsWith("opus_")
        ? "audio/ogg"
        : format.startsWith("ulaw_")
          ? "audio/basic"
          : format.startsWith("alaw_")
            ? "audio/x-alaw"
            : undefined;
  const headerType = headers?.get("content-type")?.split(";")[0];
  const contentType = headerType?.startsWith("audio/")
    ? headerType
    : formatType;
  const disposition = headers?.get("content-disposition");
  const headerFilename = disposition?.match(
    /filename="([^"]+)"|filename=([^;]+)/i,
  );
  const filename =
    headerFilename?.[1] ??
    headerFilename?.[2]?.trim() ??
    `speech.${contentType ? getExtensionFromMediaType(contentType) : "bin"}`;
  const chunks: Uint8Array[] = [];
  const alignments: unknown[] = [];
  let bytes = 0;
  let first = true;
  let stopped = false;
  const observe = (chunk: Uint8Array) => {
    if (stopped || chunk.byteLength === 0) return;
    if (first && method.startsWith("stream")) {
      span.log({
        metrics: { time_to_first_token: Date.now() / 1000 - started },
      });
    }
    first = false;
    chunks.push(new Uint8Array(chunk));
    bytes += chunk.byteLength;
  };
  const complete = () => {
    if (stopped) return;
    stopped = true;
    try {
      const content = [];
      if (contentType && bytes) {
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        content.push({
          type: "file",
          file: {
            filename,
            byte_size: bytes,
            file_data: new Attachment({
              data: new Blob([data], { type: contentType }),
              filename,
              contentType,
            }),
          },
        });
      }
      span.log({
        output: {
          content,
          ...(alignments.length ? { annotations: alignments } : {}),
        },
      });
    } finally {
      chunks.length = 0;
      finish();
    }
  };
  const cancel: Finish = (error) => {
    stopped = true;
    chunks.length = 0;
    finish(error);
  };
  const timestampChunk = (chunk: ElevenLabsTimestampAudio) => {
    const binary = atob(chunk.audioBase64);
    observe(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    if (chunk.alignment || chunk.normalizedAlignment)
      alignments.push({
        alignment: chunk.alignment,
        normalized_alignment: chunk.normalizedAlignment,
      });
  };
  if (method === "convertWithTimestamps") {
    timestampChunk(value as ElevenLabsTimestampAudio);
    complete();
  } else if (method === "streamWithTimestamps") {
    patchStreamIfNeeded<ElevenLabsTimestampAudio>(value, {
      shouldCollect: (chunk) => {
        try {
          timestampChunk(chunk);
        } catch (error) {
          debugLogger.error("Error collecting ElevenLabs timestamps", error);
          cancel();
        }
        return false;
      },
      onComplete: complete,
      onCancel: () => cancel(),
      onError: cancel,
      aroundNext: (next) => withCurrent(span, next),
    });
  } else {
    observeByteStream(value, {
      onChunk: observe,
      onComplete: complete,
      onCancel: cancel,
      aroundRead: (next) => withCurrent(span, next),
      debugLabel: "ElevenLabs audio",
    });
  }
}
