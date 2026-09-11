import { Attachment, startSpan, withCurrent, type Span } from "../../logger";
import { debugLogger } from "../../debug-logger";
import { getCurrentUnixTimestamp } from "../../util";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
} from "../../wrappers/attachment-utils";
import { isObject } from "../../../util/index";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import type {
  OpenAIMediaParams,
  OpenAIMediaResult,
  OpenAIMediaEvent,
  OpenAIMediaResponse,
} from "../../vendor-sdk-types/openai-media";
import { openAIChannels } from "./openai-channels";
import {
  buildStartSpanArgs,
  mergeInputMetadata,
} from "../core/channel-tracing-utils";

type MediaPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: unknown };
      purpose?: string;
      revised_prompt?: string;
    }
  | {
      type: "file";
      file: { filename: string; file_data: unknown; byte_size?: number };
    };

const AUDIO_TYPES = new Map(
  Object.entries({
    mp3: "audio/mpeg",
    opus: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/pcm",
  }),
);

function mediaAttachment(
  value: unknown,
  contentType: string,
  filename: string,
): unknown {
  if (value instanceof URL) return value.toString();
  if (typeof value === "string" && /^https?:/.test(value)) return value;
  const blob =
    value instanceof Blob ? value : convertDataToBlob(value, contentType);
  if (blob)
    return new Attachment({
      data: blob,
      contentType: blob.type || contentType,
      filename,
    });
  return value;
}

function mediaUsage(usage: unknown): Record<string, number> {
  if (!isObject(usage)) return {};
  const metrics: Record<string, number> = {};
  for (const [source, dest] of [
    ["input_tokens", "prompt_tokens"],
    ["output_tokens", "completion_tokens"],
    ["total_tokens", "tokens"],
  ]) {
    const value = usage[source];
    if (typeof value === "number") metrics[dest] = value;
  }
  for (const [source, prefix] of [
    ["input_token_details", "prompt"],
    ["input_tokens_details", "prompt"],
    ["output_token_details", "completion"],
    ["output_tokens_details", "completion"],
  ]) {
    const details = usage[source];
    if (!isObject(details)) continue;
    for (const key of [
      "audio_tokens",
      "text_tokens",
      "image_tokens",
      "cached_tokens",
    ]) {
      const value = details[key];
      if (typeof value === "number") metrics[`${prefix}_${key}`] = value;
    }
  }
  return metrics;
}

async function mediaInput(params: OpenAIMediaParams, operation: string) {
  const pendingContent: Array<Promise<MediaPart>> = [];
  for (const [key, purpose] of [
    ["image", "reference"],
    ["mask", "mask"],
    ["file", "input"],
  ]) {
    const value = params[key];
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      pendingContent.push(
        (async (): Promise<MediaPart> => {
          const isImage = key !== "file";
          const sourceName =
            isObject(item) && typeof item.name === "string"
              ? item.name
              : isObject(item) && typeof item.path === "string"
                ? item.path.split(/[\\/]/).pop()
                : undefined;
          const extension = sourceName?.split(".").pop()?.toLowerCase() ?? "";
          const imageTypes = new Map([
            ["jpg", "image/jpeg"],
            ["jpeg", "image/jpeg"],
            ["png", "image/png"],
            ["webp", "image/webp"],
          ]);
          const contentType =
            isObject(item) && typeof item.type === "string" && item.type
              ? item.type
              : ((isImage
                  ? imageTypes.get(extension)
                  : AUDIO_TYPES.get(extension)) ?? "application/octet-stream");
          const filename =
            sourceName ?? `input.${getExtensionFromMediaType(contentType)}`;
          let data = item;
          if (
            !(item instanceof Blob) &&
            isObject(item) &&
            typeof item.arrayBuffer === "function" &&
            typeof item.size === "number"
          ) {
            // OpenAI v4 uses formdata-node File values, which are not native Blobs.
            try {
              data = await item.arrayBuffer();
            } catch (error) {
              debugLogger.debug("OpenAI upload capture failed", error);
            }
          }
          if (
            isObject(item) &&
            typeof item.read === "function" &&
            typeof item.pipe === "function" &&
            typeof item.emit === "function" &&
            item.readableEnded !== true
          ) {
            // Observe the actual upload, including ranged file streams. Reading a
            // path separately could capture bytes the application never submitted.
            const stream = item as {
              emit(event: string, ...args: unknown[]): boolean;
            };
            data = await new Promise<unknown>((resolve) => {
              const chunks: Blob[] = [];
              const emit = stream.emit;
              let settled = false;
              stream.emit = function (event, ...args) {
                if (!settled) {
                  try {
                    if (event === "data") {
                      const chunk =
                        typeof args[0] === "string"
                          ? new Blob([args[0]])
                          : convertDataToBlob(args[0], contentType);
                      if (chunk) chunks.push(chunk);
                    }
                    if (
                      event === "end" ||
                      event === "error" ||
                      event === "close"
                    ) {
                      settled = true;
                      resolve(
                        event === "end"
                          ? new Blob(chunks, { type: contentType })
                          : item,
                      );
                      chunks.length = 0;
                    }
                  } catch (error) {
                    settled = true;
                    resolve(item);
                    debugLogger.debug("OpenAI upload capture failed", error);
                  }
                }
                return emit.call(this, event, ...args);
              };
            });
          }
          const attachment = mediaAttachment(data, contentType, filename);
          return isImage
            ? { type: "image_url", image_url: { url: attachment }, purpose }
            : { type: "file", file: { filename, file_data: attachment } };
        })(),
      );
    }
  }
  const keys =
    operation === "speech"
      ? ["voice", "speed", "language"]
      : operation === "transcribe" || operation === "translate"
        ? ["language", "timestamp_granularities"]
        : ["n", "size", "quality", "style", "background", "output_format"];
  const parameters: Record<string, unknown> = {};
  for (const key of keys)
    if (Object.hasOwn(params, key) && params[key] !== undefined)
      parameters[key] = params[key];
  if (
    ["speech", "transcribe", "translate"].includes(operation) &&
    params.response_format
  )
    parameters.format = params.response_format;
  const prompt = params.prompt ?? params.input;
  const content = await Promise.all(pendingContent);
  return {
    operation,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(content.length ? { content } : {}),
    ...(Object.keys(parameters).length ? { parameters } : {}),
  };
}

function mediaOutput(
  result: OpenAIMediaResult | string,
  params: OpenAIMediaParams,
) {
  if (typeof result === "string")
    return { content: [{ type: "text", text: result }] };
  const content: MediaPart[] = [];
  for (const item of result.data ?? []) {
    const format = result.output_format ?? params.output_format ?? "png";
    const url = item.b64_json
      ? mediaAttachment(
          item.b64_json,
          `image/${format}`,
          `generated-image.${format}`,
        )
      : item.url;
    if (url !== undefined)
      content.push({
        type: "image_url",
        image_url: { url },
        ...(item.revised_prompt ? { revised_prompt: item.revised_prompt } : {}),
      });
  }
  if (result.text !== undefined)
    content.push({ type: "text", text: result.text });
  const annotations: Record<string, unknown> = {};
  for (const key of ["language", "duration", "segments", "words"] as const)
    if (result[key] !== undefined) annotations[key] = result[key];
  return {
    content,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

/** Observe only application consumption, including APIPromise's public helpers. */
function observeMediaPromise<T>(
  promise: PromiseLike<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
  onRaw: (response: Response) => void,
): void {
  const candidate = promise as PromiseLike<T> & {
    catch?: Promise<T>["catch"];
    finally?: Promise<T>["finally"];
    withResponse?: () => Promise<{ data: T }>;
    asResponse?: () => Promise<Response>;
  };
  const then = candidate.then.bind(candidate);
  const success = (value: T) => {
    onValue(value);
    return value;
  };
  const failure = (error: unknown): never => {
    onError(error);
    throw error;
  };
  candidate.then = (fulfilled, rejected) =>
    then(success, failure).then(fulfilled, rejected);
  if (candidate.catch)
    candidate.catch = (rejected) =>
      candidate.then(undefined, rejected) as Promise<T>;
  if (candidate.finally)
    candidate.finally = (callback) =>
      Promise.resolve(candidate).finally(callback);
  let withResponse = false;
  if (candidate.withResponse) {
    const original = candidate.withResponse.bind(candidate);
    candidate.withResponse = () => {
      withResponse = true;
      return original().then((value) => {
        onValue(value.data);
        return value;
      }, failure);
    };
  }
  if (candidate.asResponse) {
    const original = candidate.asResponse.bind(candidate);
    candidate.asResponse = () =>
      original().then((response) => {
        if (!withResponse) onRaw(response);
        return response;
      }, failure);
  }
  // Native promises can be observed immediately without parsing a provider body.
  if (!candidate.asResponse)
    void then(success, (error) => {
      onError(error);
    });
}

/** Keep Response identity and native read semantics; never clone or drain it. */
function observeSpeech(
  response: Response,
  params: OpenAIMediaParams,
  span: Span,
  first: () => void,
): void {
  const responseContentType = response.headers
    .get("content-type")
    ?.split(";")[0];
  const isSSE = responseContentType === "text/event-stream";
  const contentType =
    (!isSSE &&
      responseContentType !== "application/octet-stream" &&
      responseContentType) ||
    AUDIO_TYPES.get(params.response_format ?? "mp3") ||
    "";
  const decoder = new TextDecoder();
  let pendingEvents = "";
  let observedEvents = false;
  let speechDone = false;
  const speechAudio: Blob[] = [];
  const consumeEvents = (text: string) => {
    observedEvents = true;
    pendingEvents += text.replace(/\r\n/g, "\n");
    let end;
    while ((end = pendingEvents.indexOf("\n\n")) !== -1) {
      const block = pendingEvents.slice(0, end);
      pendingEvents = pendingEvents.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event: OpenAIMediaEvent = JSON.parse(data);
      if (event.type === "speech.audio.delta" && event.audio) {
        const audio = convertDataToBlob(event.audio, contentType);
        if (audio) {
          speechAudio.push(audio);
          first();
        }
      }
      if (event.type === "speech.audio.done") {
        speechDone = true;
        span.log({ metrics: mediaUsage(event.usage) });
      }
    }
  };
  const observeBytes = (bytes: Uint8Array) => {
    if (isSSE) consumeEvents(decoder.decode(bytes, { stream: true }));
    else if (bytes.byteLength) first();
  };
  const filename =
    response.headers
      .get("content-disposition")
      ?.match(/filename="?([^";]+)/)?.[1] ??
    `speech.${[...AUDIO_TYPES].find(([, type]) => type === contentType)?.[0] ?? getExtensionFromMediaType(contentType)}`;
  let completed = false;
  let cancelled = false;
  const finish = async (blob: Blob) => {
    if (completed || cancelled || !contentType) return;
    completed = true;
    if (isSSE) {
      if (!observedEvents) consumeEvents(await blob.text());
      consumeEvents(decoder.decode() + "\n\n");
      if (!speechDone || !speechAudio.length) return;
      blob = new Blob(speechAudio, { type: contentType });
    } else if (blob.size) first();
    span.log({
      metrics: { end: getCurrentUnixTimestamp() },
      output: {
        content: [
          {
            type: "file",
            file: {
              filename,
              file_data: new Attachment({ data: blob, contentType, filename }),
              byte_size: blob.size,
            },
          },
        ],
      },
    });
  };
  for (const method of ["arrayBuffer", "blob"] as const) {
    const original = response[method].bind(response);
    Object.defineProperty(response, method, {
      configurable: true,
      value: async () => {
        let value;
        try {
          value = await original();
        } catch (error) {
          cancelled = true;
          try {
            span.log({ error });
          } catch {}
          throw error;
        }
        try {
          await finish(
            value instanceof Blob
              ? value
              : new Blob([value], { type: contentType }),
          );
        } catch (error) {
          debugLogger.debug("OpenAI speech capture failed", error);
        }
        return value;
      },
    });
  }
  const body = response.body;
  if (!body) return;
  const chunks: Blob[] = [];
  if (typeof body.cancel === "function") {
    const cancel = body.cancel.bind(body);
    body.cancel = (...args) => {
      const result = cancel(...args);
      cancelled = true;
      chunks.length = 0;
      return result;
    };
  }
  if (!("getReader" in body)) {
    // node-fetch (OpenAI v4) uses a Node Readable. Observing emit does not put
    // the stream into flowing mode, unlike adding a data listener.
    const nodeBody = body as unknown as {
      emit(event: string, ...args: unknown[]): boolean;
    };
    const emit = nodeBody.emit;
    nodeBody.emit = function (event, ...args) {
      try {
        if (event === "data") {
          const blob = convertDataToBlob(args[0], contentType);
          if (blob) {
            chunks.push(blob);
            if (args[0] instanceof Uint8Array) observeBytes(args[0]);
          }
        }
        if (event === "end")
          void finish(new Blob(chunks, { type: contentType })).catch((error) =>
            debugLogger.debug("OpenAI speech capture failed", error),
          );
        if (event === "error" || event === "close") {
          cancelled = true;
          chunks.length = 0;
          if (event === "error") span.log({ error: args[0] });
        }
      } catch (error) {
        debugLogger.debug("OpenAI speech capture failed", error);
      }
      return emit.call(this, event, ...args);
    };
    return;
  }
  const originalGetReader = body.getReader.bind(body);
  Object.defineProperty(body, "getReader", {
    configurable: true,
    value: (...args: Parameters<typeof body.getReader>) => {
      const reader = originalGetReader(...args);
      const read = reader.read.bind(reader);
      const cancel = reader.cancel.bind(reader);
      reader.cancel = (...args) => {
        const result = cancel(...args);
        cancelled = true;
        chunks.length = 0;
        return result;
      };
      Object.defineProperty(reader, "read", {
        configurable: true,
        value: (...readArgs: unknown[]) =>
          Reflect.apply(read, reader, readArgs).then(
            async (result: ReadableStreamReadResult<Uint8Array>) => {
              try {
                if (result.done)
                  await finish(new Blob(chunks, { type: contentType }));
                else {
                  observeBytes(result.value);
                  const value = result.value;
                  chunks.push(
                    new Blob([
                      new Uint8Array(
                        value.buffer,
                        value.byteOffset,
                        value.byteLength,
                      ),
                    ]),
                  );
                }
              } catch (error) {
                debugLogger.debug("OpenAI speech capture failed", error);
              }
              return result;
            },
            (error: unknown) => {
              cancelled = true;
              chunks.length = 0;
              try {
                span.log({ error });
              } catch {}
              throw error;
            },
          ),
      });
      return reader;
    },
  });
  // Native pipe operations bypass getReader overrides. Insert an observer only
  // when the application explicitly starts a pipe, retaining bounded backpressure.
  const pipeThrough = body.pipeThrough.bind(body);
  const pipeTo = body.pipeTo.bind(body);
  Object.defineProperty(body, "pipeTo", {
    configurable: true,
    value: (
      destination: WritableStream<Uint8Array>,
      options?: StreamPipeOptions,
    ) => {
      if (
        !(destination instanceof WritableStream) ||
        destination.locked ||
        body.locked
      )
        return pipeTo(destination, options);
      const observer = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          try {
            observeBytes(chunk);
            chunks.push(new Blob([chunk]));
          } catch (error) {
            debugLogger.debug("OpenAI speech capture failed", error);
          }
          controller.enqueue(chunk);
        },
      });
      return pipeThrough(observer)
        .pipeTo(destination, options)
        .then(
          async () => {
            try {
              await finish(new Blob(chunks, { type: contentType }));
            } catch (error) {
              debugLogger.debug("OpenAI speech capture failed", error);
            }
          },
          (error) => {
            cancelled = true;
            chunks.length = 0;
            try {
              span.log({ error });
            } catch {}
            throw error;
          },
        );
    },
  });
  Object.defineProperty(body, "pipeThrough", {
    configurable: true,
    value: (
      transform: ReadableWritablePair<unknown, Uint8Array>,
      options?: StreamPipeOptions,
    ) => {
      if (
        !transform ||
        !(transform.readable instanceof ReadableStream) ||
        !(transform.writable instanceof WritableStream) ||
        transform.writable.locked ||
        body.locked
      )
        return pipeThrough(transform, options);
      const observer = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          try {
            observeBytes(chunk);
            chunks.push(new Blob([chunk]));
          } catch (error) {
            debugLogger.debug("OpenAI speech capture failed", error);
          }
          controller.enqueue(chunk);
        },
        async flush() {
          try {
            await finish(new Blob(chunks, { type: contentType }));
          } catch (error) {
            debugLogger.debug("OpenAI speech capture failed", error);
          }
        },
      });
      return pipeThrough(observer).pipeThrough(transform, options);
    },
  });
  // Async iteration uses native internal readers, so observe its public path too.
  patchStreamIfNeeded<Uint8Array>(body, {
    onChunk: (chunk) => {
      observeBytes(chunk);
      chunks.push(new Blob([chunk]));
    },
    onComplete: () => finish(new Blob(chunks, { type: contentType })),
    onCancel: () => {
      cancelled = true;
      chunks.length = 0;
    },
    onError: (error) => {
      cancelled = true;
      chunks.length = 0;
      span.log({ error });
    },
  });
  if ("values" in body)
    Object.defineProperty(body, "values", {
      configurable: true,
      value: Reflect.get(body, Symbol.asyncIterator),
    });
}

type MediaChannel = typeof openAIChannels.imagesGenerate;
export function interceptOpenAIMedia(
  channel: MediaChannel,
  operation: string,
): () => void {
  return channel.intercept((target, thisArg, args, additional) => {
    if (isAutoInstrumentationSuppressed()) return target.apply(thisArg, args);
    const params = args[0];
    let span: Span;
    try {
      const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
        { name: `openai.${channel.channelName}`, type: "llm" },
        { arguments: args, span_info: additional.span_info },
      );
      span = startSpan(
        withSpanInstrumentationName(
          {
            name,
            spanAttributes,
            event: {
              metadata: mergeInputMetadata(
                {
                  // Provider defaults can change independently of the SDK version.
                  model:
                    params.model ??
                    (operation === "variation" ? "dall-e-2" : undefined),
                  provider: "openai",
                },
                spanInfoMetadata,
              ),
            },
          },
          INSTRUMENTATION_NAMES.OPENAI,
        ),
      );
    } catch (error) {
      debugLogger.debug("OpenAI media span failed", error);
      return target.apply(thisArg, args);
    }
    void mediaInput(params, operation)
      .then((input) => span.log({ input }))
      .catch((error) => debugLogger.debug("OpenAI media input failed", error));
    const start = getCurrentUnixTimestamp();
    let seen = false;
    let ended = false;
    const first = () => {
      if (!seen) {
        seen = true;
        span.log({
          metrics: { time_to_first_token: getCurrentUnixTimestamp() - start },
        });
      }
    };
    const finish = (result?: OpenAIMediaResult | string, error?: unknown) => {
      if (ended) return;
      ended = true;
      try {
        if (result !== undefined)
          span.log({
            output: mediaOutput(result, params),
            ...(typeof result === "object"
              ? {
                  metrics: mediaUsage(result.usage),
                  ...(result.model
                    ? { metadata: { model: result.model } }
                    : {}),
                }
              : {}),
          });
        if (error !== undefined) span.log({ error });
      } catch (error) {
        debugLogger.debug("OpenAI media output failed", error);
      } finally {
        try {
          span.end();
        } catch (error) {
          debugLogger.debug("OpenAI media finalization failed", error);
        }
      }
    };
    let observed = false;
    const onValue = (value: OpenAIMediaResponse) => {
      if (observed) return;
      observed = true;
      try {
        if (
          value instanceof Response ||
          (isObject(value) &&
            typeof Reflect.get(value, "arrayBuffer") === "function" &&
            Reflect.get(value, "headers"))
        ) {
          span.log({ output: { content: [] } });
          observeSpeech(value as Response, params, span, first);
          finish();
        } else if (isAsyncIterable(value)) {
          const accumulated: OpenAIMediaResult = {};
          const audio: Blob[] = [];
          patchStreamIfNeeded<OpenAIMediaEvent>(value, {
            onChunk: (event) => {
              if (event.b64_json || event.audio || event.delta || event.text)
                first();
              if (event.usage) accumulated.usage = event.usage;
              if (event.model) accumulated.model = event.model;
              if (event.type.endsWith(".completed") && event.b64_json) {
                accumulated.data = [
                  ...(accumulated.data ?? []),
                  { b64_json: event.b64_json },
                ];
                accumulated.output_format = event.output_format;
              }
              if (event.type === "transcript.text.delta")
                accumulated.text =
                  (accumulated.text ?? "") + (event.delta ?? "");
              if (event.type === "transcript.text.done")
                accumulated.text = event.text ?? accumulated.text;
              if (event.type === "transcript.text.segment")
                accumulated.segments = [...(accumulated.segments ?? []), event];
              if (event.audio) {
                const blob = convertDataToBlob(
                  event.audio,
                  AUDIO_TYPES.get(params.response_format ?? "mp3") ??
                    "application/octet-stream",
                );
                if (blob) audio.push(blob);
              }
            },
            onComplete: () => {
              finish(accumulated);
              if (audio.length) {
                const contentType =
                  AUDIO_TYPES.get(params.response_format ?? "mp3") ??
                  "application/octet-stream";
                const filename = `speech.${params.response_format ?? "mp3"}`;
                span.log({
                  output: {
                    content: [
                      {
                        type: "file",
                        file: {
                          filename,
                          file_data: new Attachment({
                            data: new Blob(audio, { type: contentType }),
                            contentType,
                            filename,
                          }),
                        },
                      },
                    ],
                  },
                });
              }
            },
            onCancel: () => finish(accumulated),
            onError: (error) => finish(accumulated, error),
          });
        } else finish(value as OpenAIMediaResult | string);
      } catch (error) {
        debugLogger.debug("OpenAI media observation failed", error);
        finish();
      }
    };
    let result;
    try {
      result = withCurrent(span, () =>
        runWithAutoInstrumentationSuppressed(() => target.apply(thisArg, args)),
      );
    } catch (error) {
      finish(undefined, error);
      throw error;
    }
    try {
      observeMediaPromise(
        result,
        onValue,
        (error) => finish(undefined, error),
        (response) => {
          if (operation === "speech") onValue(response);
          else finish();
        },
      );
    } catch (error) {
      debugLogger.debug("OpenAI media promise observation failed", error);
      finish();
    }
    return result;
  });
}
