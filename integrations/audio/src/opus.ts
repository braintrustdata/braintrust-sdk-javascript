import type { AudioMiddleware } from "./types";
import type { EncodedPacket, EncodedPackets } from "./packets";

export interface OpusOptions {
  /** Target bitrate in bits per second. Defaults to 64000. */
  bitrate?: number;
  /** Encoder effort from 0 (fastest) to 10. Defaults to 5. */
  complexity?: number;
  /** Encoder tuning. Defaults to `"audio"`; `"voip"` favors speech. */
  application?: "audio" | "voip" | "lowdelay";
}

const OPUS_RATE = 48000;
/** Frames (20 ms each) encoded between yields to the event loop: 1 s of audio. */
const FRAMES_PER_YIELD = 50;

type Codec = typeof import("@audio/encode-opus/core");
let codec: Promise<Codec> | undefined;

/**
 * Encodes raw PCM segments into Opus packets for a container such as `ogg()`.
 * Accepts 1 or 2 channels of s16le PCM at 24 or 48 kHz. Encoding runs in
 * 20 ms frames and yields to the event loop after each second of audio.
 */
export function opus(
  options: OpusOptions = {},
): AudioMiddleware<Uint8Array, EncodedPackets> {
  const settings = {
    bitrate: 64_000,
    complexity: 5,
    application: "audio" as const,
    ...options,
  };
  return async function opus(segment, meta, next) {
    if (meta.mimeType !== "audio/pcm" || meta.encoding !== "s16le")
      throw new Error("opus requires s16le PCM input");
    const channels = meta.channelCount;
    if (channels !== 1 && channels !== 2)
      throw new Error("opus supports 1 or 2 channels");
    const { createOpusEncoder, toOpusRate, FRAME } = await (codec ??=
      import("@audio/encode-opus/core"));
    const encoder = await createOpusEncoder({
      channels,
      ...settings,
      // The codec takes kbps.
      bitrate: settings.bitrate / 1000,
    });
    const packets: EncodedPacket[] = [];
    let delay: number;
    let padding: number;
    try {
      delay = encoder.lookahead;
      const frame = new Float32Array(FRAME * channels);
      let filled = 0;
      let total = 0;
      const encode = () => {
        frame.fill(0, filled);
        packets.push({ data: encoder.encode(frame), samples: FRAME });
        filled = 0;
      };
      // Samples are 16-bit, so an odd byte offset needs an aligned copy.
      const bytes = segment.byteOffset % 2 ? segment.slice() : segment;
      const pcm = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 2,
      );
      for (const block of planarBlocks(
        chunks(pcm, meta.sampleRate, channels),
        meta.sampleRate,
        channels,
        toOpusRate,
      )) {
        total += block[0].length;
        for (let i = 0; i < block[0].length; i++) {
          for (let c = 0; c < channels; c++) frame[filled++] = block[c][i];
          if (filled === frame.length) {
            encode();
            if (packets.length % FRAMES_PER_YIELD === 0)
              await yieldToEventLoop();
          }
        }
      }
      // Push the encoder delay out with silence, then trim it when decoding.
      while (packets.length * FRAME < total + delay) encode();
      padding = packets.length * FRAME - total - delay;
    } finally {
      encoder.free();
    }
    return next(
      {
        codec: "opus",
        headers: [opusHead(channels, delay, meta.sampleRate)],
        packets,
        delay,
        padding,
      },
      {
        ...meta,
        sampleRate: OPUS_RATE,
        mimeType: "audio/opus",
        encoding: "opus",
      },
    );
  };
}

/** Loads and compiles the codec ahead of the first segment. */
export function warmOpus(): Promise<void> {
  return (codec ??= import("@audio/encode-opus/core"))
    .then(({ createOpusEncoder }) => createOpusEncoder())
    .then((encoder) => encoder.free());
}

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/** 100 ms blocks of interleaved PCM. */
function* chunks(pcm: Int16Array, sampleRate: number, channels: number) {
  const size = (sampleRate / 10) * channels;
  for (let at = 0; at < pcm.length; at += size)
    yield pcm.subarray(at, at + size);
}

/**
 * Resamples interleaved PCM blocks to planar 48 kHz, preserving the codec's
 * Lanczos filter across blocks with three samples of history and lookahead.
 * Only the start and end of the segment clamp the filter.
 */
function* planarBlocks(
  chunks: Iterable<Int16Array>,
  sampleRate: number,
  channels: number,
  toOpusRate: Codec["toOpusRate"],
) {
  if (sampleRate !== 24000 && sampleRate !== OPUS_RATE)
    throw new Error("opus supports 24 or 48 kHz input");
  const tail = Array.from({ length: channels }, () => new Float32Array(6));
  let retained = 3;
  let initialized = false;
  let input: Float32Array[] = [];
  let output: Float32Array[] = [];
  function convert(length: number, end: number) {
    const interleaved = toOpusRate(
      input.map((c) => c.subarray(0, length)),
      sampleRate,
    );
    const ratio = OPUS_RATE / sampleRate;
    const count = (end - 3) * ratio;
    if (!output.length || output[0].length < count)
      output = Array.from({ length: channels }, () => new Float32Array(count));
    for (let i = 0; i < count; i++)
      for (let c = 0; c < channels; c++)
        output[c][i] = interleaved[(i + 3 * ratio) * channels + c];
    return output.map((c) => c.subarray(0, count));
  }
  for (const pcm of chunks) {
    if (!pcm.length) continue;
    const length = retained + pcm.length / channels;
    if (!input.length || input[0].length < length)
      input = Array.from({ length: channels }, () => new Float32Array(length));
    if (!initialized) {
      for (let c = 0; c < channels; c++) tail[c].fill(pcm[c] / 32768, 0, 3);
      initialized = true;
    }
    for (let c = 0; c < channels; c++) {
      input[c].set(tail[c].subarray(0, retained));
      for (let i = 0; i < pcm.length / channels; i++)
        input[c][retained + i] = pcm[i * channels + c] / 32768;
    }
    const end = Math.max(3, length - 3);
    if (end > 3) yield convert(length, end);
    retained = length - end + 3;
    for (let c = 0; c < channels; c++)
      tail[c].set(input[c].subarray(end - 3, length));
  }
  if (initialized) {
    for (let c = 0; c < channels; c++)
      input[c].set(tail[c].subarray(0, retained));
    yield convert(retained, retained);
  }
}

/** Opus identification header (RFC 7845 §5.1), channel mapping family 0. */
function opusHead(channels: number, preSkip: number, inputSampleRate: number) {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // mapping family
  return head;
}
