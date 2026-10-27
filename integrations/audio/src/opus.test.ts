import { expect, test } from "vitest";
import oggOpus from "@audio/encode-opus";
import type { AudioSegmentMeta } from "./types";
import { opus, type OpusOptions } from "./opus";
import type { EncodedPackets } from "./packets";

const meta = (sampleRate: number, channelCount: number): AudioSegmentMeta => ({
  index: 2,
  startOffsetMs: 4000,
  durationMs: 1000,
  sampleRate,
  channels: Array.from({ length: channelCount }, (_, channel) => ({
    sources: channel === 0 ? ["session_input"] : [],
  })),
  mimeType: "audio/pcm",
  encoding: "pcm",
  attributes: {
    "pcm.sample_format": "s16le",
    "pcm.channel_layout": "interleaved",
    "acme.call_id": "c-1",
  },
});

/** Speech-like test tones, a different pitch per channel, as interleaved s16le. */
function tones(frames: number, sampleRate: number, channels: number) {
  const pcm = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++)
      pcm[i * channels + c] = Math.round(
        9000 * Math.sin((2 * Math.PI * (220 + 110 * c) * i) / sampleRate),
      );
  return pcm;
}
const bytes = (pcm: Int16Array) => new Uint8Array(pcm.buffer);

/** Runs opus() and captures what it passes down the stack. */
async function encode(
  pcm: Int16Array,
  segmentMeta: AudioSegmentMeta,
  options?: OpusOptions,
) {
  let down: { segment: EncodedPackets; meta: AudioSegmentMeta } | undefined;
  await opus(options)(bytes(pcm), segmentMeta, async (segment, meta) => {
    down = { segment, meta };
    return { segment: new Uint8Array(), meta };
  });
  return down!;
}

/** Packets and the final granule position from an Ogg Opus file (RFC 3533). */
function oggPackets(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const packets: Uint8Array[] = [];
  let partial: number[] = [];
  let granule = 0;
  for (let at = 0; at < file.length; ) {
    granule = Number(view.getBigUint64(at + 6, true));
    const count = file[at + 26];
    let data = at + 27 + count;
    for (let i = 0; i < count; i++) {
      const size = file[at + 27 + i];
      partial.push(...file.subarray(data, data + size));
      data += size;
      if (size < 255) {
        packets.push(Uint8Array.from(partial));
        partial = [];
      }
    }
    at = data;
  }
  return { head: packets[0], audio: packets.slice(2), granule };
}

/** The library's own Ogg encoder, with opus() defaults, as the reference. */
async function reference(
  pcm: Int16Array,
  sampleRate: number,
  channels: number,
) {
  const planar = Array.from({ length: channels }, (_, c) =>
    Float32Array.from(
      { length: pcm.length / channels },
      (_, i) => pcm[i * channels + c] / 32768,
    ),
  );
  const encoder = await oggOpus({
    sampleRate,
    channels,
    bitrate: 64,
    complexity: 5,
    application: "audio",
  });
  try {
    const parts = [encoder.encode(planar), encoder.flush()];
    const file = new Uint8Array(parts[0].length + parts[1].length);
    file.set(parts[0]);
    file.set(parts[1], parts[0].length);
    return oggPackets(file);
  } finally {
    encoder.free();
  }
}

test.each([
  { frames: 1, sampleRate: 24000, channels: 2 },
  { frames: 3, sampleRate: 24000, channels: 2 },
  { frames: 24001, sampleRate: 24000, channels: 2 },
  { frames: 72123, sampleRate: 24000, channels: 2 },
  { frames: 24000, sampleRate: 24000, channels: 1 },
  { frames: 48017, sampleRate: 48000, channels: 2 },
])(
  "packets match the reference encoder for $frames frames of $channels-channel $sampleRate Hz",
  async ({ frames, sampleRate, channels }) => {
    const pcm = tones(frames, sampleRate, channels);
    const { segment } = await encode(pcm, meta(sampleRate, channels));
    const expected = await reference(pcm, sampleRate, channels);
    expect(segment.codec).toBe("opus");
    expect(segment.headers).toEqual([expected.head]);
    expect(segment.packets.map((p) => p.data)).toEqual(expected.audio);
    // Decoded length after trimming the delay and padding is the input's, at 48 kHz.
    const decoded = segment.packets.reduce((sum, p) => sum + p.samples, 0);
    expect(decoded - segment.delay - segment.padding).toBe(
      (frames * 48000) / sampleRate,
    );
    expect(decoded - segment.padding).toBe(expected.granule);
  },
);

test("PCM at an odd byte offset encodes like aligned PCM", async () => {
  const pcm = tones(4800, 24000, 2);
  const shifted = new Uint8Array(pcm.byteLength + 1);
  shifted.set(bytes(pcm), 1);
  let down: EncodedPackets | undefined;
  await opus()(shifted.subarray(1), meta(24000, 2), async (segment, m) => {
    down = segment;
    return { segment: new Uint8Array(), meta: m };
  });
  const aligned = await encode(pcm, meta(24000, 2));
  expect(down!.packets).toEqual(aligned.segment.packets);
});

test("metadata describes Opus at 48 kHz on the same timeline and channels", async () => {
  const input = meta(24000, 2);
  const { meta: output } = await encode(tones(2400, 24000, 2), input);
  // The encoder's settings, defaults included, replace the PCM details.
  expect(output).toEqual({
    ...input,
    sampleRate: 48000,
    mimeType: "audio/opus",
    encoding: "opus",
    attributes: {
      "acme.call_id": "c-1",
      "opus.bitrate_bps": 64000,
      "opus.complexity": 5,
      "opus.application": "audio",
    },
  });
});

test("attributes report configured settings", async () => {
  const { meta: output } = await encode(tones(480, 24000, 1), meta(24000, 1), {
    bitrate: 32_500,
    complexity: 9,
    application: "voip",
  });
  expect(output.attributes).toMatchObject({
    "opus.bitrate_bps": 32500,
    "opus.complexity": 9,
    "opus.application": "voip",
  });
});

test.each([
  [{ bitrate: 0 }, "bitrate"],
  [{ bitrate: Number.NaN }, "bitrate"],
  [{ bitrate: 499 }, "bitrate"],
  [{ bitrate: 512_001 }, "bitrate"],
  [{ bitrate: 32_000.5 }, "bitrate"],
  [{ bitrate: "32000" }, "bitrate"],
  [{ complexity: 2.5 }, "complexity"],
  [{ complexity: 11 }, "complexity"],
  [{ complexity: -1 }, "complexity"],
  [{ application: "music" }, "application"],
])("rejects option %j", (options, option) => {
  expect(() => opus(options as OpusOptions)).toThrow(`Opus ${option} must`);
});

test.each([
  [{ bitrate: 500 }],
  [{ bitrate: 512_000 }],
  [{ complexity: 0 }],
  [{ complexity: 10 }],
  [{ bitrate: undefined }],
])("accepts option %j", (options) => {
  expect(() => opus(options)).not.toThrow();
});

test("options change the encoding", async () => {
  const pcm = tones(48000, 24000, 2);
  const size = async (options: OpusOptions) =>
    (await encode(pcm, meta(24000, 2), options)).segment.packets.reduce(
      (sum, p) => sum + p.data.length,
      0,
    );
  expect(await size({ bitrate: 16_000 })).toBeLessThan(await size({}));
});

test.each([
  ["non-PCM input", { ...meta(24000, 2), mimeType: "audio/ogg" }],
  [
    "another sample format",
    { ...meta(24000, 2), attributes: { "pcm.sample_format": "f32le" } },
  ],
  ["more than two channels", meta(24000, 3)],
  ["an unsupported sample rate", meta(16000, 2)],
])("rejects %s", async (_name, input) => {
  await expect(
    opus()(bytes(tones(160, 16000, 3)), input, () => {
      throw new Error("next must not run");
    }),
  ).rejects.toThrow(/opus/);
});

test("long segments yield to the event loop while encoding", async () => {
  await encode(tones(240, 24000, 2), meta(24000, 2)); // Load the codec first.
  let ticks = 0;
  let timer: NodeJS.Immediate;
  const tick = () => {
    ticks++;
    timer = setImmediate(tick);
  };
  timer = setImmediate(tick);
  try {
    await encode(tones(5 * 24000, 24000, 2), meta(24000, 2));
  } finally {
    clearImmediate(timer);
  }
  // Five seconds of audio yields after each of its first four seconds.
  expect(ticks).toBeGreaterThanOrEqual(4);
});

test("concurrent segments encode independently", async () => {
  const a = tones(36000, 24000, 2);
  const b = tones(30000, 24000, 2).map((v) => -v);
  const sequential = [
    await encode(a, meta(24000, 2)),
    await encode(b, meta(24000, 2)),
  ];
  const concurrent = await Promise.all([
    encode(a, meta(24000, 2)),
    encode(b, meta(24000, 2)),
  ]);
  expect(concurrent).toEqual(sequential);
});
