import { Attachment } from "./logger/core";
import { audioEncodingStack } from "./audio-compression";
import { runMiddleware } from "./audio-middleware";
import type { AudioEncodingConfig } from "./instrumentation/config";
import { debugLogger } from "./debug-logger";

export type PcmFormat = { sampleRate: number; channels: number };

// SDK copies may create and export the same attachment. Each registry entry
// owns one clip; no encoder or recording state is reused across entries.
const key = Symbol.for("braintrust.audioAttachmentEncoders");
const shared = globalThis as typeof globalThis & {
  [key]?: WeakMap<
    object,
    { original: Attachment; encode(): Promise<Attachment> }
  >;
};
const encoders = () => (shared[key] ??= new WeakMap());
const defaults = {
  codec: { name: "opus" },
  container: { name: "ogg" },
} as const;

/** Snapshot first; encode only surviving attachments during asynchronous export. */
export function audioAttachment(
  blob: Blob,
  filename: string,
  configured?: AudioEncodingConfig,
  pcm?: PcmFormat,
): Attachment {
  const original = new Attachment({
    data: blob,
    contentType: blob.type,
    filename,
  });
  if (
    configured?.codec?.name === "pcm" ||
    !["audio/pcm", "audio/wav", "audio/x-wav", "audio/wave"].includes(blob.type)
  )
    return original;
  let pending: Promise<Attachment> | undefined;
  encoders().set(original, { original, encode: () => (pending ??= encode()) });
  async function encode(): Promise<Attachment> {
    try {
      // A new stack and codec instance for each clip, including concurrent clips.
      const stack = audioEncodingStack(configured, defaults);
      if (!stack.length) return original;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const source =
        blob.type === "audio/pcm" ? pcm && { bytes, ...pcm } : wavPcm(bytes);
      if (
        !source ||
        ![24000, 48000].includes(source.sampleRate) ||
        ![1, 2].includes(source.channels) ||
        !source.bytes.length ||
        source.bytes.length % (2 * source.channels)
      )
        return original;
      const result = await runMiddleware(stack, source.bytes, {
        index: 0,
        startOffsetMs: 0,
        durationMs:
          (source.bytes.length / (2 * source.channels * source.sampleRate)) *
          1000,
        sampleRate: source.sampleRate,
        channels: Array.from({ length: source.channels }, () => ({
          sources: [],
        })),
        mimeType: "audio/pcm",
        encoding: "pcm",
        attributes: {
          "pcm.sample_format": "s16le",
          "pcm.channel_layout": "interleaved",
        },
      });
      return new Attachment({
        data: new Blob([Uint8Array.from(result.segment)], {
          type: result.meta.mimeType,
        }),
        contentType: result.meta.mimeType,
        filename: filename.replace(/\.[^/.]*$/, "") + ".ogg",
      });
    } catch (error) {
      debugLogger.debug(
        "Audio attachment encoding failed; retaining original audio",
        error,
      );
      return original;
    }
  }
  return original;
}

/** Only parse a declared WAV container; never guess a format from arbitrary bytes. */
function wavPcm(
  bytes: Uint8Array,
): (PcmFormat & { bytes: Uint8Array }) | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 12 ||
    view.getUint32(0) !== 0x52494646 ||
    view.getUint32(8) !== 0x57415645
  )
    return;
  // OpenAI's streamed WAV responses use unknown RIFF/data lengths. This is
  // called only after complete consumption, so the captured EOF bounds them.
  const riffLength = view.getUint32(4, true);
  const end = riffLength === 0xffffffff ? bytes.length : riffLength + 8;
  if (end > bytes.length || end < 12) return;
  let format: PcmFormat | undefined;
  let data: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= end;) {
    const id = view.getUint32(offset);
    const declaredLength = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const length =
      id === 0x64617461 && declaredLength === 0xffffffff
        ? end - start
        : declaredLength;
    if (start + length > end) return;
    if (id === 0x666d7420 && length >= 16) {
      if (
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 14, true) !== 16
      )
        return;
      format = {
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
      };
      if (view.getUint16(start + 12, true) !== format.channels * 2) return;
    }
    if (id === 0x64617461) {
      if (data) return; // Preserve unusual multi-data WAVs rather than lose audio.
      data = bytes.subarray(start, start + length);
    }
    offset = start + length + (length % 2);
  }
  return format && data ? { ...format, bytes: data } : undefined;
}

/** Runs after privacy filtering/customization, before attachment references export. */
export async function encodeAudioAttachments<T extends object>(
  record: T,
): Promise<T> {
  if (!shared[key]) return record;
  const encoded = new Map<object, Attachment>();
  const descriptions = new Map<
    object,
    | {
        original: { content_type: string; filename: string };
        stored: { content_type: string; filename: string };
      }
    | undefined
  >();
  async function walk(value: unknown, depth = 0): Promise<unknown> {
    if (value === null || typeof value !== "object" || depth >= 128)
      return value;
    const pending = encoders().get(value);
    if (pending) {
      // Reserve order before awaiting concurrent codecs so metadata stays stable.
      if (!descriptions.has(value)) descriptions.set(value, undefined);
      const result = await pending.encode();
      if (result !== value && !encoded.has(value)) {
        encoded.set(value, result);
        descriptions.set(value, {
          original: {
            content_type: pending.original.reference.content_type,
            filename: pending.original.reference.filename,
          },
          stored: {
            content_type: result.reference.content_type,
            filename: result.reference.filename,
          },
        });
      }
      return result;
    }
    if (Array.isArray(value))
      return Promise.all(value.map((item) => walk(item, depth + 1)));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return value;
    const fields = value as Record<string, unknown>;
    const result = Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([k, v]) => [
          k,
          await walk(v, depth + 1),
        ]),
      ),
    );
    if (
      fields.file_data !== null &&
      typeof fields.file_data === "object" &&
      encoded.has(fields.file_data)
    ) {
      const attachment = encoded.get(fields.file_data)!;
      result.filename = attachment.reference.filename;
      if ("byte_size" in value)
        result.byte_size = (await attachment.data()).size;
    }
    return result;
  }
  const result = (await walk(record)) as T & {
    metadata?: Record<string, unknown>;
  };
  const formats = [...descriptions.values()].filter(
    (item) => item !== undefined,
  );
  if (formats.length) {
    result.metadata = {
      ...result.metadata,
      "contrib.audio.encodings": formats,
    };
  }
  return result;
}
