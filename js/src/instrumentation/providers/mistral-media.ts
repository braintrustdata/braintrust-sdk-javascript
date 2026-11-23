import { Attachment, startSpan, withCurrent } from "../../logger/core";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  MistralOCRParams,
  MistralOCRResponse,
  MistralTranscriptionParams,
  MistralTranscriptionResponse,
  MistralTranscriptionEvent,
  MistralSpeechParams,
  MistralSpeechResult,
  MistralSpeechEvent,
} from "../../vendor-sdk-types/mistral";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  isAutoCaptureAttachmentsEnabled,
  isEnvFlagEnabled,
} from "../../wrappers/attachment-utils";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { observeResult, runInstrumentation } from "../core/observe-result";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import { buildStartSpanArgs, mergeInputMetadata } from "../core/tracing-utils";

const AUDIO_CONTENT_TYPES = new Map([
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["opus", "audio/ogg"],
  ["ogg", "audio/ogg"],
  ["m4a", "audio/mp4"],
  ["webm", "audio/webm"],
  ["pcm", "application/octet-stream"],
]);

// Never read a caller's stream or fetch a URL to capture input media.
function media(
  value: unknown,
  contentType: string,
  capture: boolean,
  filename?: string,
  audioCaptureFlag = "BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS",
): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (!capture) return "<omitted>";
  if (typeof value === "string" && value.startsWith("data:")) {
    contentType = value.match(/^data:([^;,]+)/)?.[1] ?? contentType;
  }
  if (value instanceof Blob && value.type) contentType = value.type;
  if (
    /^(audio|video)\//i.test(contentType) &&
    !isEnvFlagEnabled(audioCaptureFlag)
  )
    return "<omitted>";
  const blob =
    value instanceof Blob ? value : convertDataToBlob(value, contentType);
  if (!blob) return "<omitted>";
  return new Attachment({
    data: blob,
    contentType: blob.type || contentType,
    filename: filename ?? `media.${getExtensionFromMediaType(contentType)}`,
  });
}

export function extractMistralOCRInput([params]: [
  MistralOCRParams,
  ...unknown[],
]) {
  const d = params.document;
  const capture = isAutoCaptureAttachmentsEnabled();
  return {
    input: {
      operation: "ocr",
      content:
        d.imageUrl !== undefined
          ? [
              {
                type: "image_url",
                image_url: { url: media(d.imageUrl, "image/jpeg", capture) },
              },
            ]
          : [
              {
                type: "file",
                file: {
                  filename: d.documentName ?? "document.pdf",
                  file_data:
                    d.fileId ??
                    media(d.documentUrl, "application/pdf", capture),
                },
              },
            ],
      parameters: {
        pages: params.pages,
        include_images: params.includeImageBase64,
        table_format: params.tableFormat,
      },
    },
    metadata: { provider: "mistral", model: params.model },
  };
}

export function extractMistralOCROutput(result: MistralOCRResponse) {
  const capture = isAutoCaptureAttachmentsEnabled();
  const content: unknown[] = [];
  return {
    content,
    annotations: {
      documentAnnotation: result.documentAnnotation,
      usage: result.usageInfo && {
        pagesProcessed: result.usageInfo.pagesProcessed,
        docSizeBytes: result.usageInfo.docSizeBytes,
      },
      pages: result.pages.map((page) => ({
        index: page.index,
        markdown: page.markdown,
        header: page.header,
        footer: page.footer,
        dimensions: page.dimensions && {
          dpi: page.dimensions.dpi,
          height: page.dimensions.height,
          width: page.dimensions.width,
        },
        tables: page.tables?.map((table) => ({
          id: table.id,
          content: table.content,
          format: table.format,
        })),
        hyperlinks: page.hyperlinks,
        images: page.images.map((image) => {
          const contentIndex = image.imageBase64 ? content.length : undefined;
          if (image.imageBase64)
            content.push({
              type: "image_url",
              image_url: {
                url: media(
                  image.imageBase64,
                  "image/jpeg",
                  capture,
                  undefined,
                  "BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS",
                ),
              },
            });
          return {
            id: image.id,
            topLeftX: image.topLeftX,
            topLeftY: image.topLeftY,
            bottomRightX: image.bottomRightX,
            bottomRightY: image.bottomRightY,
            imageAnnotation: image.imageAnnotation,
            contentIndex,
          };
        }),
      })),
    },
  };
}

export function extractMistralTranscriptionInput([params]: [
  MistralTranscriptionParams,
  ...unknown[],
]) {
  const capture =
    isAutoCaptureAttachmentsEnabled() &&
    isEnvFlagEnabled("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS");
  const file = params.file;
  const filename =
    file instanceof Blob && "name" in file && typeof file.name === "string"
      ? file.name
      : file instanceof Blob
        ? "audio"
        : (file?.fileName ?? "audio");
  const extension = filename.split(".").pop()?.toLowerCase();
  const contentType =
    AUDIO_CONTENT_TYPES.get(extension ?? "") ?? "application/octet-stream";
  return {
    input: {
      operation: "transcribe",
      prompt: params.contextBias?.join(", "),
      content: [
        {
          type: "file",
          file: {
            filename,
            file_data:
              params.fileId ??
              (file instanceof Blob
                ? media(file, file.type || contentType, capture, filename)
                : media(
                    file?.content ?? params.fileUrl,
                    contentType,
                    capture,
                    filename,
                  )),
          },
        },
      ],
      parameters: {
        language: params.language,
        timestamp_granularities: params.timestampGranularities,
      },
    },
    metadata: { provider: "mistral", model: params.model },
  };
}

export function extractMistralTranscriptionOutput(
  result: MistralTranscriptionResponse,
) {
  return {
    content:
      result.text === undefined ? [] : [{ type: "text", text: result.text }],
    annotations: {
      language: result.language,
      duration: result.usage?.promptAudioSeconds,
      segments: result.segments?.map((segment) => ({
        text: segment.text,
        start: segment.start,
        end: segment.end,
        speakerId: segment.speakerId,
      })),
    },
  };
}

export function mistralMediaMetrics(
  usage: Record<string, unknown> | undefined,
) {
  const metrics: Record<string, number> = {};
  for (const [key, name] of [
    ["promptTokens", "prompt_tokens"],
    ["completionTokens", "completion_tokens"],
    ["totalTokens", "tokens"],
  ]) {
    const value = usage?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      metrics[name] = value;
  }
  const extra = usage?.additionalProperties;
  const details =
    usage?.prompt_tokens_details ??
    (extra && typeof extra === "object"
      ? Reflect.get(extra, "prompt_tokens_details")
      : undefined);
  if (details && typeof details === "object") {
    for (const [key, name] of [
      ["audio_tokens", "prompt_audio_tokens"],
      ["cached_tokens", "prompt_cached_tokens"],
    ]) {
      const value = Reflect.get(details, key);
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        metrics[name] = value;
    }
  }
  // Voxtral reports text prompt tokens separately from audio tokens. The total
  // includes both; canonical prompt_tokens must include all input modalities.
  if (
    metrics.tokens !== undefined &&
    metrics.completion_tokens !== undefined &&
    metrics.tokens >= metrics.completion_tokens
  ) {
    metrics.prompt_tokens = metrics.tokens - metrics.completion_tokens;
  }
  return metrics;
}

export function mistralMediaMetadata(result: {
  model?: string;
  usage?: Record<string, unknown>;
}) {
  const metadata: Record<string, string> = {};
  if (result.model) metadata.model = result.model;
  const extra = result.usage?.additionalProperties;
  const tier =
    result.usage?.serviceTier ??
    result.usage?.service_tier ??
    (extra && typeof extra === "object"
      ? Reflect.get(extra, "service_tier")
      : undefined);
  if (typeof tier === "string") metadata.served_service_tier = tier;
  return metadata;
}

// Observe SSE as the caller consumes it, without retaining encoded audio chunks.
// Encoded files stay whole. Raw float32 LE PCM can be segmented on sample boundaries.
export function traceMistralAudio<
  T extends PromiseLike<
    MistralSpeechResult | AsyncIterable<MistralTranscriptionEvent>
  >,
>(
  call: () => T,
  event: {
    arguments: [MistralSpeechParams | MistralTranscriptionParams, ...unknown[]];
    self: unknown;
  },
  streamingAttachmentBufferBytes: number,
): T {
  if (isAutoInstrumentationSuppressed()) return call();
  const setup = runInstrumentation(() => {
    const request = event.arguments[0];
    const speech = "input" in request;
    const params = speech ? request : undefined;
    const capture =
      isAutoCaptureAttachmentsEnabled() &&
      isEnvFlagEnabled("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS");
    const format = params?.responseFormat ?? "mp3";
    const contentType =
      AUDIO_CONTENT_TYPES.get(format) ?? "application/octet-stream";
    const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
      {
        name: speech
          ? "mistral.audio.speech.complete"
          : "mistral.audio.transcriptions.stream",
        type: "llm",
      },
      event,
    );
    const data =
      "input" in request
        ? {
            input: {
              operation: "speech",
              prompt: request.input,
              parameters: { voice: request.voiceId, format },
              content: request.refAudio
                ? [
                    {
                      type: "file",
                      file: {
                        filename: "reference.wav",
                        file_data: media(
                          request.refAudio,
                          "audio/wav",
                          isAutoCaptureAttachmentsEnabled() &&
                            isEnvFlagEnabled(
                              "BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS",
                            ),
                        ),
                      },
                    },
                  ]
                : undefined,
            },
            metadata: { provider: "mistral", model: request.model },
          }
        : extractMistralTranscriptionInput([request]);
    const span = startSpan(
      withSpanInstrumentationName(
        {
          name,
          spanAttributes,
          event: {
            ...data,
            metadata: mergeInputMetadata(data.metadata, spanInfoMetadata),
          },
        },
        INSTRUMENTATION_NAMES.MISTRAL,
      ),
    );
    return { span, speech, params, capture, format, contentType };
  });
  if (!setup) return call();
  const { span, speech, params, capture, format, contentType } = setup;
  let transcription: MistralTranscriptionResponse = { text: "" };
  const start = getCurrentUnixTimestamp();
  let first = true;
  let ended = false;
  let parts: Uint8Array[] = [];
  let bytes = 0;
  let offset = 0;
  const content: unknown[] = [];
  const segments: unknown[] = [];
  let omitted = !capture;
  const threshold = Math.max(
    4,
    Math.floor(streamingAttachmentBufferBytes / 4) * 4,
  );
  const flush = (final: boolean) => {
    if (!bytes) return;
    // An incomplete encoded response is not a playable file.
    if (!final && format !== "pcm") {
      parts = [];
      bytes = 0;
      return;
    }
    const length = format === "pcm" ? bytes - (bytes % 4) : bytes;
    const joined = new Uint8Array(bytes);
    let position = 0;
    for (const part of parts) {
      joined.set(part, position);
      position += part.length;
    }
    if (length) {
      content.push({
        type: "file",
        file: {
          file_data: new Attachment({
            data: new Blob([joined.slice(0, length)], { type: contentType }),
            contentType,
            filename: `speech.${format}`,
          }),
          filename: `speech.${format}`,
          byte_size: length,
        },
      });
      if (format === "pcm")
        segments.push({
          content_index: content.length - 1,
          byte_offset: offset,
          encoding: "float32le",
          // The pinned Voxtral TTS model emits mono 24 kHz float32 PCM.
          // https://learn.mistral.ai/public/blogs/designing-a-speech-to-speech-assistant-2026-04-02
          ...(params?.model === "voxtral-mini-tts-2603"
            ? {
                sample_rate: 24000,
                channels: 1,
                start_seconds: offset / (24000 * 4),
                duration_seconds: length / (24000 * 4),
              }
            : {}),
        });
      span.log({
        output: {
          content: [...content],
          ...(segments.length
            ? { annotations: { segments: [...segments] } }
            : {}),
        },
      });
      offset += length;
    }
    parts = length < bytes ? [joined.slice(length)] : [];
    bytes -= length;
  };
  const finish = (complete: boolean, error?: unknown) => {
    if (ended) return;
    ended = true;
    if (!speech)
      runInstrumentation(() => {
        span.log({
          output: extractMistralTranscriptionOutput(transcription),
          metrics: mistralMediaMetrics(transcription.usage),
          metadata: mistralMediaMetadata(transcription),
        });
      });
    else runInstrumentation(() => flush(complete));
    if (speech && omitted && !content.length)
      span.log({
        output: {
          content: [
            {
              type: "file",
              file: { filename: `speech.${format}`, file_data: "<omitted>" },
            },
          ],
        },
      });
    if (error !== undefined) span.log({ error });
    span.end();
  };
  const observeAudio = (audio: string, streaming: boolean) => {
    if (!capture || omitted) return;
    if (
      streaming &&
      audio.length >
        Math.ceil(Math.max(32 * 1024 * 1024, threshold * 2) / 3) * 4
    ) {
      omitted = true;
      parts = [];
      bytes = 0;
      return;
    }
    // Decode synchronously so observation never delays or races stream completion.
    let decoded: Uint8Array;
    try {
      decoded = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
    } catch {
      omitted = true;
      parts = [];
      bytes = 0;
      return;
    }
    if (
      streaming &&
      bytes + decoded.length > Math.max(32 * 1024 * 1024, threshold * 2)
    ) {
      omitted = true;
      parts = [];
      bytes = 0;
      return;
    }
    if (streaming && format === "pcm") {
      for (let pos = 0; pos < decoded.length;) {
        const size = Math.min(threshold - bytes, decoded.length - pos);
        parts.push(decoded.slice(pos, pos + size));
        bytes += size;
        pos += size;
        if (bytes >= threshold) flush(false);
      }
    } else {
      parts.push(decoded);
      bytes += decoded.length;
    }
  };
  let result: T;
  try {
    result = withCurrent(span, call);
  } catch (error) {
    finish(false, error);
    throw error;
  }
  return observeResult(
    result,
    (value) => {
      if (isAsyncIterable(value)) {
        patchStreamIfNeeded<MistralSpeechEvent | MistralTranscriptionEvent>(
          value,
          {
            aroundNext: (callback) => withCurrent(span, callback),
            shouldCollect: (event) => {
              runInstrumentation(() => {
                const data = event.data;
                const hasContent =
                  ("audioData" in data && !!data.audioData) ||
                  ("text" in data && !!data.text);
                if (first && hasContent) {
                  first = false;
                  span.log({
                    metrics: {
                      time_to_first_token: getCurrentUnixTimestamp() - start,
                    },
                  });
                }
                if (!speech && "text" in data) {
                  if (data.type === "transcription.done") {
                    transcription = {
                      text: data.text,
                      language: data.language,
                      segments: data.segments?.map((segment) => ({
                        ...segment,
                      })),
                      model: data.model,
                      usage: data.usage,
                    };
                  } else if (data.type === "transcription.text.delta")
                    transcription.text += data.text ?? "";
                  else if (data.type === "transcription.segment")
                    (transcription.segments ??= []).push({
                      text: data.text ?? "",
                      start: data.start ?? null,
                      end: data.end ?? null,
                      speakerId: data.speakerId,
                    });
                }
                if (
                  data.type === "transcription.language" &&
                  "language" in data
                )
                  transcription.language = data.language;
                if (
                  data.type === "speech.audio.delta" &&
                  "audioData" in data &&
                  data.audioData
                )
                  observeAudio(data.audioData, true);
                if (data.type === "speech.audio.done")
                  span.log({
                    metrics: mistralMediaMetrics(data.usage),
                    metadata: mistralMediaMetadata(data),
                  });
              });
              return false;
            },
            onComplete: () => finish(true),
            onCancel: () => finish(false),
            onError: (error) => finish(false, error),
          },
        );
      } else {
        try {
          observeAudio(value.audioData, false);
        } finally {
          finish(true);
        }
      }
    },
    (error) => finish(false, error),
  );
}
