import { isObject } from "../../../util";
import { Attachment, startSpan, withCurrent } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type { FalArgs, FalStream } from "../../vendor-sdk-types/fal";
import { wrapFal } from "../../wrappers/fal";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  isAutoCaptureAttachmentsEnabled,
  isEnvFlagEnabled,
} from "../../wrappers/attachment-utils";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { observeResult, runInstrumentation } from "../core/observe-result";
import { traceAsyncCall, unsubscribeAll } from "../core/tracing";
import { falChannels } from "./fal-interceptors";

export class FalPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      falChannels.createClient.intercept((target, receiver, args) =>
        wrapFal(Reflect.apply(target, receiver, args)),
      ),
    );
    this.unsubscribers.push(
      falChannels.run.intercept((target, receiver, args, additional) =>
        traceAsyncCall<typeof falChannels.run>(
          () =>
            runWithAutoInstrumentationSuppressed(() =>
              Reflect.apply(target, receiver, args),
            ),
          { ...additional, arguments: args, self: receiver },
          {
            name: "fal.run",
            instrumentationName: INSTRUMENTATION_NAMES.FAL,
            type: "llm",
            shouldTrace: (args) => isFalModelRequest(args as FalArgs),
            extractInput: ([model, options]) => ({
              input: falInput(model, options?.input),
              metadata: { provider: "fal", model },
            }),
            extractOutput: (result) => falOutput(result.data),
            extractMetadata: (result) => ({ request_id: result.requestId }),
            extractMetrics: () => ({}),
          },
        ),
      ),
    );
    this.unsubscribers.push(
      falChannels.stream.intercept((target, receiver, args) =>
        traceFalStream(() => Reflect.apply(target, receiver, args), args),
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

// Prediction endpoints have model-specific schemas. Capture common media fields
// and canonical generation parameters, never arbitrary transport/configuration.
function falInput(model: string, input: unknown) {
  const request = isObject(input) ? input : {};
  const operation = /(?:kokoro|tts|text-to-speech)/.test(model)
    ? "speech"
    : /(?:whisper|transcrib|speech-to-text)/.test(model)
      ? "transcribe"
      : /(?:image-to-image|inpaint|edit)/.test(model)
        ? "edit"
        : "generate";
  const content: Record<string, unknown>[] = [];
  for (const [key, kind] of [
    ["image_url", "image"],
    ["image_urls", "image"],
    ["mask_url", "image"],
    ["audio_url", "audio"],
    ["video_url", "video"],
  ] as const) {
    const value = request[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      const part = falMediaPart(item, kind, "USER");
      if (part)
        content.push(
          kind === "image"
            ? { ...part, purpose: key === "mask_url" ? "mask" : "reference" }
            : part,
        );
    }
  }
  const parameterKeys =
    operation === "speech"
      ? {
          voice: "voice",
          output_format: "format",
          speed: "speed",
          language: "language",
        }
      : operation === "transcribe"
        ? {
            language: "language",
            format: "format",
            timestamp_granularities: "timestamp_granularities",
          }
        : {
            num_images: "n",
            image_size: "size",
            aspect_ratio: "aspect_ratio",
            quality: "quality",
            style: "style",
            seed: "seed",
            background: "background",
            output_format: "output_format",
            duration: "duration",
          };
  const parameters = Object.fromEntries(
    Object.entries(parameterKeys)
      .filter(([key]) => request[key] !== undefined)
      .map(([key, canonical]) => [canonical, request[key]]),
  );
  return {
    operation,
    ...(typeof request.prompt === "string" ? { prompt: request.prompt } : {}),
    ...(content.length ? { content } : {}),
    ...(Object.keys(parameters).length ? { parameters } : {}),
  };
}

function falOutput(value: unknown) {
  const result = isObject(value) ? value : {};
  const content: Record<string, unknown>[] = [];
  for (const [key, kind] of [
    ["images", "image"],
    ["image", "image"],
    ["audio", "audio"],
    ["audios", "audio"],
    ["video", "video"],
    ["videos", "video"],
  ] as const) {
    const field = result[key];
    for (const item of Array.isArray(field) ? field : [field]) {
      const part = falMediaPart(item, kind, "AGENT");
      if (part) content.push(part);
    }
  }
  const text =
    typeof value === "string" ? value : (result.text ?? result.transcript);
  if (typeof text === "string") content.push({ type: "text", text });
  const annotations = Object.fromEntries(
    ["seed", "has_nsfw_concepts", "language", "duration", "segments", "words"]
      .filter((key) => result[key] !== undefined)
      .map((key) => [key, result[key]]),
  );
  return {
    content,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

function falMediaPart(
  value: unknown,
  kind: "image" | "audio" | "video",
  direction: "USER" | "AGENT",
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const file = isObject(value) ? value : {};
  const data =
    typeof value === "string" || value instanceof Blob ? value : file.url;
  if (typeof data !== "string" && !(data instanceof Blob)) return undefined;
  const inline = data instanceof Blob || data.startsWith("data:");
  const contentType =
    data instanceof Blob
      ? data.type
      : inline
        ? data.slice(5, data.indexOf(",")).split(";")[0]
        : typeof file.content_type === "string"
          ? file.content_type
          : undefined;
  const filename =
    typeof file.file_name === "string"
      ? file.file_name
      : typeof File !== "undefined" && data instanceof File
        ? data.name
        : contentType
          ? `fal.${getExtensionFromMediaType(contentType)}`
          : `fal.${kind}`;
  let reference: unknown = data;
  if (inline) {
    // MIME and field kind both gate consent, including mislabeled media fields.
    const recording =
      kind !== "image" || /^(audio|video)\//.test(contentType ?? "");
    const capture =
      isAutoCaptureAttachmentsEnabled() &&
      (!recording ||
        isEnvFlagEnabled(`BRAINTRUST_CAPTURE_${direction}_AUDIO_ATTACHMENTS`));
    const blob =
      capture && contentType && /^(image|audio|video)\//.test(contentType)
        ? data instanceof Blob
          ? data
          : convertDataToBlob(data, contentType)
        : undefined;
    reference = blob
      ? new Attachment({ data: blob, contentType: contentType!, filename })
      : "<omitted>";
  }
  if (kind === "image")
    return {
      type: "image_url",
      image_url: {
        url: reference,
        ...(typeof file.width === "number" ? { width: file.width } : {}),
        ...(typeof file.height === "number" ? { height: file.height } : {}),
      },
    };
  return {
    type: "file",
    file: {
      filename,
      file_data: reference,
      ...(typeof file.file_size === "number"
        ? { byte_size: file.file_size }
        : data instanceof Blob
          ? { byte_size: data.size }
          : {}),
    },
  };
}

function isFalModelRequest([endpoint, options]: FalArgs): boolean {
  return (
    typeof endpoint === "string" &&
    ![endpoint, options?.url, options?.path, options?.subdomain].some(
      (value) =>
        typeof value === "string" &&
        /(?:^|[/.])(?:queue|requests|status|result|cancel|batch|realtime|live)(?:[/.]|$|[?#])/.test(
          value,
        ),
    ) &&
    (typeof options?.method !== "string" ||
      options.method.toLowerCase() === "post")
  );
}

function traceFalStream(
  call: () => Promise<FalStream>,
  [model, options]: FalArgs,
): Promise<FalStream> {
  if (isAutoInstrumentationSuppressed() || !isFalModelRequest([model, options]))
    return call();
  const span = startSpan(
    withSpanInstrumentationName(
      {
        name: "fal.stream",
        spanAttributes: { type: "llm" },
        event: { metadata: { provider: "fal", model } },
      },
      INSTRUMENTATION_NAMES.FAL,
    ),
  );
  runInstrumentation(() =>
    span.log({ input: falInput(model, options?.input) }),
  );
  const started = Date.now() / 1000;
  let ended = false;
  const finish = (error?: unknown) => {
    if (ended) return;
    ended = true;
    if (error !== undefined) span.log({ error });
    span.end();
  };
  let result: Promise<FalStream>;
  try {
    result = withCurrent(span, () =>
      runWithAutoInstrumentationSuppressed(call),
    );
  } catch (error) {
    finish(error);
    throw error;
  }
  // FalStream starts reading immediately and supports three consumption styles.
  // Observing done() covers all of them without draining or replacing its iterator.
  return observeResult(
    result,
    (stream) => {
      let first = true;
      let binaryBytes = 0;
      const binaryChunks: Uint8Array[] = [];
      const contentType = options?.accept?.split(";")[0].trim().toLowerCase();
      const captureBinary =
        contentType &&
        /^(image|audio|video)\/[a-z0-9.+-]+$/.test(contentType) &&
        isAutoCaptureAttachmentsEnabled() &&
        (contentType.startsWith("image/") ||
          isEnvFlagEnabled("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS"));
      stream.on("data", (value) => {
        if (ended) return;
        runInstrumentation(() => {
          const binary = ArrayBuffer.isView(value);
          const content =
            typeof value === "string"
              ? value.length > 0
              : isObject(value) &&
                [
                  "images",
                  "image",
                  "audio",
                  "audios",
                  "video",
                  "videos",
                  "text",
                  "transcript",
                ].some((key) => {
                  const item = value[key];
                  return Array.isArray(item) ? item.length > 0 : Boolean(item);
                });
          if (first && (binary || content)) {
            span.log({
              metrics: { time_to_first_token: Date.now() / 1000 - started },
            });
            first = false;
          }
          if (binary) {
            binaryBytes += value.byteLength;
            if (captureBinary)
              binaryChunks.push(
                new Uint8Array(
                  new Uint8Array(
                    value.buffer,
                    value.byteOffset,
                    value.byteLength,
                  ),
                ),
              );
          }
        });
      });
      const abort = () => {
        binaryChunks.length = 0;
        finish();
      };
      stream.signal.addEventListener("abort", abort, { once: true });
      if (stream.signal.aborted) abort();
      observeResult(
        stream.done(),
        (output) => {
          stream.signal.removeEventListener("abort", abort);
          if (ended) return;
          runInstrumentation(() => {
            // Binary HTTP chunks have no media boundaries. Only attach a complete
            // file with an explicit MIME type; never split encoded files at the
            // streaming buffer threshold or upload a cancelled/failed fragment.
            const part =
              binaryChunks.length && contentType
                ? falMediaPart(
                    new Blob(binaryChunks, { type: contentType }),
                    contentType.startsWith("image/")
                      ? "image"
                      : contentType.startsWith("audio/")
                        ? "audio"
                        : "video",
                    "AGENT",
                  )
                : undefined;
            span.log({
              output: binaryBytes
                ? {
                    content: part ? [part] : [],
                    annotations: { byte_size: binaryBytes },
                  }
                : falOutput(output),
              metadata: { request_id: stream.requestId },
            });
          });
          binaryChunks.length = 0;
          finish();
        },
        (error) => {
          stream.signal.removeEventListener("abort", abort);
          binaryChunks.length = 0;
          finish(error);
        },
      );
    },
    finish,
  );
}
