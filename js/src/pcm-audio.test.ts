import { expect, test } from "vite-plus/test";
import { PcmAudio } from "./pcm-audio";

const MAX = Number.MAX_SAFE_INTEGER;
// Without a chunk-sized limit, flush consumes everything through the cut.
const all = { maxBytes: MAX, flush: true };
async function bytes(result: ReturnType<PcmAudio["digest"]>) {
  return Buffer.from(await (await result!.attachment.data()).arrayBuffer());
}
const samples = (data: Buffer) =>
  Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2));
const mono = (sampleRate: number, offsetMs = 0, channel = 0) => ({
  sampleRate,
  channels: 1,
  channel,
  offsetMs,
});

test("positioned sources are downmixed and resampled onto separate channels with silent gaps", async () => {
  const audio = new PcmAudio({
    sampleRate: 24000,
    channels: 2,
  });
  audio.update(new Int16Array([100, 300, 300, 500]), {
    sampleRate: 12000,
    channels: 2,
    channel: 0,
    offsetMs: 0,
  });
  audio.update(new Int16Array([-1, -2]), mono(24000, 2 / 24, 1));
  const result = audio.digest({ ...all, filename: "speech.pcm" });
  expect(samples(await bytes(result))).toEqual([
    200, 0, 300, 0, 400, -1, 400, -2,
  ]);
  expect(result).toMatchObject({
    channels: [0, 1],
    startOffsetMs: 0,
    metadata: {
      mime_type: "audio/pcm",
      sample_rate_hz: 24000,
      channel_count: 2,
      sample_format: "s16le",
      duration_ms: 4 / 24,
    },
  });
  expect(result!.attachment.reference).toMatchObject({
    filename: "speech.pcm",
    content_type: "audio/pcm",
  });
  expect(audio.bufferedByteLength).toBe(0);
});

test("updates copy input and digests cannot be changed by later writes", async () => {
  const audio = new PcmAudio({ sampleRate: 1000, channels: 1 });
  const source = new Int16Array([1, 2, 3, 4]);
  audio.update(source, mono(1000));
  source.fill(0);
  // Later writes win at overlaps.
  audio.update(new Int16Array([9, 8]), mono(1000, 1));
  const first = audio.digest({ ...all, endOffsetMs: 2 });
  expect(samples(await bytes(first))).toEqual([1, 9]);
  expect(() => audio.update(new Int16Array([7]), mono(1000, 1))).toThrow(
    "capture_clock_discontinuity",
  );
  const rest = audio.digest(all);
  expect(samples(await bytes(rest))).toEqual([8, 4]);
  expect(rest!.startOffsetMs).toBe(first!.endOffsetMs);
});

test("cuts preserve resampled audio sample-for-sample", async () => {
  const whole = new PcmAudio({ sampleRate: 24000, channels: 2 });
  const split = new PcmAudio({ sampleRate: 24000, channels: 2 });
  const source = Int16Array.from(
    { length: 4410 },
    (_, i) => ((i * 157) % 60001) - 30000,
  );
  for (const audio of [whole, split]) audio.update(source, mono(44100, 0, 1));
  const pieces = [];
  for (const endOffsetMs of [7 / 24, 13.5, 33.125, 99, 100])
    pieces.push(await bytes(split.digest({ ...all, endOffsetMs })));
  expect(Buffer.concat(pieces)).toEqual(await bytes(whole.digest(all)));
  expect(split.bufferedByteLength).toBe(0);
});

test("bounds storage and output allocation without consuming data on failure", async () => {
  const audio = new PcmAudio({
    sampleRate: 1000,
    channels: 1,
    maxBufferBytes: 4,
  });
  audio.update(new Int16Array([1, 2]), mono(1000));
  expect(() => audio.update(new Int16Array([3]), mono(1000, 2))).toThrow(
    "capture_byte_limit",
  );
  expect(audio.bufferedByteLength).toBe(4);
  expect(samples(await bytes(audio.digest(all)))).toEqual([1, 2]);
  audio.update(new Int16Array([7]), mono(1000, 1000000));
  expect(() => audio.digest(all)).toThrow("capture_byte_limit");
  expect(audio.digest({ ...all, endOffsetMs: 1000000 })).toBeUndefined();
  expect(samples(await bytes(audio.digest(all)))).toEqual([7]);
});

test("rejects invalid formats, incomplete frames, cuts and byte limits", () => {
  expect(() => new PcmAudio({ sampleRate: 0, channels: 1 })).toThrow();
  expect(() => new PcmAudio({ sampleRate: 24000, channels: 0 })).toThrow();
  const audio = new PcmAudio({ sampleRate: 24000, channels: 2 });
  const stereo = { sampleRate: 24000, channels: 2, channel: 0, offsetMs: 0 };
  expect(() => audio.update(new Int16Array([1]), stereo)).toThrow(
    "incomplete_pcm_frame",
  );
  expect(() =>
    audio.update(new Int16Array([1, 2]), { ...stereo, channel: 2 }),
  ).toThrow("unsupported_audio_format");
  expect(() =>
    audio.update(new Int16Array([1, 2]), { ...stereo, offsetMs: NaN }),
  ).toThrow("unsupported_audio_format");
  audio.update(new Int16Array([1, 2]), stereo);
  for (const endOffsetMs of [1000, -1])
    expect(() => audio.digest({ ...all, endOffsetMs })).toThrow(
      "invalid_digest_offset",
    );
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, MAX + 1])
    expect(() => audio.digest({ maxBytes })).toThrow(
      "invalid_digest_byte_limit",
    );
  expect(audio.bufferedByteLength).toBe(2);
});

test("byte-limited digests wait for confirmed full chunks and flush a final remainder", async () => {
  const audio = new PcmAudio({ sampleRate: 1000, channels: 2 });
  const source = Int16Array.from({ length: 6 }, (_, i) => i + 1);
  audio.update(source, mono(1000));
  expect(audio.digest({ maxBytes: 8, endOffsetMs: 1 })).toBeUndefined();
  const first = audio.digest({ maxBytes: 8, endOffsetMs: 3 });
  expect(first).toMatchObject({ startOffsetMs: 0, endOffsetMs: 2 });
  expect(audio.digest({ maxBytes: 8, endOffsetMs: 3 })).toBeUndefined();
  const second = audio.digest({ maxBytes: 8, endOffsetMs: 3, flush: true });
  expect(second).toMatchObject({ startOffsetMs: 2, endOffsetMs: 3 });
  const third = audio.digest({ maxBytes: 8 });
  expect(audio.digest({ maxBytes: 8 })).toBeUndefined();
  const last = audio.digest({ maxBytes: 8, flush: true });
  const data = Buffer.concat(
    await Promise.all([first, second, third, last].map(bytes)),
  );
  expect(samples(data)).toEqual([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]);
  expect(audio.bufferedByteLength).toBe(0);
});

test.each([
  { channels: 1, maxBytes: 1, sizes: [2, 2, 2, 2, 2] },
  { channels: 2, maxBytes: 9, sizes: [8, 8, 4] },
  { channels: 3, maxBytes: 13, sizes: [12, 12, 6] },
])(
  "byte limits align to complete frames for $channels channels",
  async ({ channels, maxBytes, sizes }) => {
    const audio = new PcmAudio({ sampleRate: 1000, channels });
    audio.update(new Int16Array([1, 2, 3, 4, 5]), mono(1000));
    const files: Buffer[] = [];
    while (audio.bufferedByteLength)
      files.push(await bytes(audio.digest({ maxBytes, flush: true })));
    expect(files.map((f) => f.length)).toEqual(sizes);
  },
);

test("byte-limited digests skip empty intervals and retain silence inside a file", async () => {
  const audio = new PcmAudio({ sampleRate: 1000, channels: 1 });
  audio.update(new Int16Array([7]), mono(1000, 5));
  audio.update(new Int16Array([9]), mono(1000, 8));
  const first = audio.digest({ maxBytes: 4 });
  expect(first).toMatchObject({ startOffsetMs: 4, endOffsetMs: 6 });
  expect(samples(await bytes(first))).toEqual([0, 7]);
  expect(audio.digest({ maxBytes: 4 })).toBeUndefined();
  const last = audio.digest({ maxBytes: 4, flush: true });
  expect(last).toMatchObject({ startOffsetMs: 8, endOffsetMs: 9 });
  expect(samples(await bytes(last))).toEqual([9]);
});
