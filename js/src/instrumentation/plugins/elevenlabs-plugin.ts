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
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
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
          observeAudioStream(
            file,
            (chunk) => chunks.push(new Uint8Array(chunk)),
            () => {
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
            () => {
              chunks.length = 0;
            },
            span,
          );
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
    observeAudioStream(value, observe, complete, cancel, span);
  }
}

/** Observe reads in place; never drain or tee a provider's one-shot audio. */
function observeAudioStream(
  value: unknown,
  observe: (chunk: Uint8Array) => void,
  complete: () => void,
  cancel: Finish,
  span: Span,
): void {
  let ended = false;
  const safeObserve = (chunk: Uint8Array) => {
    if (ended) return;
    try {
      observe(chunk);
    } catch (error) {
      debugLogger.error("Error collecting ElevenLabs audio", error);
      end(false);
    }
  };
  const end = (success: boolean, error?: unknown) => {
    if (ended) return;
    ended = true;
    try {
      if (success) complete();
      else cancel(error);
    } catch (loggingError) {
      debugLogger.error("Error logging ElevenLabs audio", loggingError);
      cancel();
    }
  };
  if (!isObject(value) || !Object.isExtensible(value)) {
    end(false);
    return;
  }
  // node-fetch returns a Node Readable. Observing data emission does not put
  // it into flowing mode, and snapshots bytes before application listeners run.
  if (typeof value.read === "function" && typeof value.on === "function") {
    value.on("end", () => end(true));
    value.on("close", () => end(false));
    const emit = value.emit;
    if (typeof emit === "function")
      value.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event === "data" && args[0] instanceof Uint8Array)
          safeObserve(args[0]);
        if (event === "error") end(false, args[0]);
        return Reflect.apply(emit, this, [event, ...args]);
      };
    return;
  }
  if (typeof value.getReader === "function") {
    const webStream = value as unknown as ReadableStream<Uint8Array>;
    const pipeTo = webStream.pipeTo;
    const pipeThrough = webStream.pipeThrough;
    // Native piping bypasses getReader()/iteration. Add the observation only
    // when the application starts piping, preserving downstream backpressure.
    webStream.pipeTo = function (destination, options) {
      if (!isObject(destination) || this.locked || destination.locked)
        return pipeTo.call(this, destination, options);
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          safeObserve(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          end(true);
        },
      });
      const observed = pipeThrough.call(
        this,
        tap,
        options,
      ) as ReadableStream<Uint8Array>;
      return observed.pipeTo(destination, options).catch((error) => {
        end(false, error);
        throw error;
      });
    };
    webStream.pipeThrough = function <T>(
      transform: ReadableWritablePair<T, Uint8Array>,
      options?: StreamPipeOptions,
    ): ReadableStream<T> {
      if (this.locked || transform.writable.locked || transform.readable.locked)
        return pipeThrough.call(this, transform, options) as ReadableStream<T>;
      const result = webStream.pipeTo.call(this, transform.writable, options);
      // pipeThrough marks its internal pipe promise handled, just like the
      // native implementation. Errors still propagate through the transform.
      void result.catch(() => {});
      return transform.readable;
    };
    const getReader = value.getReader;
    value.getReader = function (...args: unknown[]) {
      const reader = Reflect.apply(getReader, this, args);
      const read = reader.read as (
        ...args: unknown[]
      ) => Promise<ReadableStreamReadResult<Uint8Array>>;
      reader.read = function (...readArgs: unknown[]) {
        return Promise.resolve(
          withCurrent(span, () => Reflect.apply(read, this, readArgs)),
        ).then(
          (result: ReadableStreamReadResult<Uint8Array>) => {
            if (result.value) safeObserve(result.value);
            if (result.done) end(true);
            return result;
          },
          (error: unknown) => {
            end(false, error);
            throw error;
          },
        );
      };
      const readerCancel = reader.cancel;
      reader.cancel = function (...cancelArgs: unknown[]) {
        const result = Reflect.apply(readerCancel, this, cancelArgs);
        end(false);
        return result;
      };
      return reader;
    };
    const streamCancel = value.cancel;
    if (typeof streamCancel === "function")
      value.cancel = function (...args: unknown[]) {
        const result = Reflect.apply(streamCancel, this, args);
        void Promise.resolve(result).then(
          () => end(false),
          () => {},
        );
        return result;
      };
  }
  if (
    typeof value.getReader === "function" &&
    typeof value.values === "function"
  ) {
    const values = value.values;
    const iterate = function (this: unknown, ...args: unknown[]) {
      const iterator = Reflect.apply(values, this, args);
      patchStreamIfNeeded<Uint8Array>(iterator, {
        shouldCollect(chunk) {
          safeObserve(chunk);
          return false;
        },
        onComplete: () => end(true),
        onCancel: () => end(false),
        onError: (error) => end(false, error),
        aroundNext: (next) => withCurrent(span, next),
      });
      return iterator;
    };
    value.values = iterate;
    Object.defineProperty(value, Symbol.asyncIterator, {
      configurable: true,
      writable: true,
      value: iterate,
    });
  } else if (isAsyncIterable(value)) {
    patchStreamIfNeeded<Uint8Array>(value, {
      shouldCollect: (chunk) => {
        safeObserve(chunk);
        return false;
      },
      onComplete: () => end(true),
      onCancel: () => end(false),
      onError: (error) => end(false, error),
      aroundNext: (next) => withCurrent(span, next),
    });
  } else if (typeof value.getReader !== "function") end(false);
}
