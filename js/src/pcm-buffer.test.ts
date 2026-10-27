import { expect, test } from "vitest";
import { PcmBuffer } from "./pcm-buffer";

const MAX = Number.MAX_SAFE_INTEGER;
// Without a chunk-sized limit, a partial flush consumes everything through the cut.
const all = { maxBytes: MAX, partial: true };
function bytes(result: ReturnType<PcmBuffer["flush"]>) {
  return Buffer.from(result!.data);
}
const samples = (data: Buffer) =>
  Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2));
const mono = (sampleRate: number, offsetMs = 0, channel = 0) => ({
  sampleRate,
  channels: 1,
  channel,
  offsetMs,
});

test("positioned sources are downmixed and resampled onto separate channels with silent gaps", () => {
  const audio = new PcmBuffer({
    sampleRate: 24000,
    channels: 2,
  });
  audio.write(new Int16Array([100, 300, 300, 500]), {
    sampleRate: 12000,
    channels: 2,
    channel: 0,
    offsetMs: 0,
  });
  audio.write(new Int16Array([-1, -2]), mono(24000, 2 / 24, 1));
  const result = audio.flush(all);
  expect(samples(bytes(result))).toEqual([200, 0, 300, 0, 400, -1, 400, -2]);
  expect(result).toMatchObject({
    channels: [0, 1],
    startOffsetMs: 0,
    endOffsetMs: 4 / 24,
  });
  expect(audio.bufferedByteLength).toBe(0);
});

test("writes copy input and flushes cannot be changed by later writes", () => {
  const audio = new PcmBuffer({ sampleRate: 1000, channels: 1 });
  const source = new Int16Array([1, 2, 3, 4]);
  audio.write(source, mono(1000));
  source.fill(0);
  // Later writes win at overlaps.
  audio.write(new Int16Array([9, 8]), mono(1000, 1));
  const first = audio.flush({ ...all, endOffsetMs: 2 });
  expect(samples(bytes(first))).toEqual([1, 9]);
  expect(() => audio.write(new Int16Array([7]), mono(1000, 1))).toThrow(
    "capture_clock_discontinuity",
  );
  const rest = audio.flush(all);
  expect(samples(bytes(rest))).toEqual([8, 4]);
  expect(rest!.startOffsetMs).toBe(first!.endOffsetMs);
});

test("cuts preserve resampled audio sample-for-sample", () => {
  const whole = new PcmBuffer({ sampleRate: 24000, channels: 2 });
  const split = new PcmBuffer({ sampleRate: 24000, channels: 2 });
  const source = Int16Array.from(
    { length: 4410 },
    (_, i) => ((i * 157) % 60001) - 30000,
  );
  for (const audio of [whole, split]) audio.write(source, mono(44100, 0, 1));
  const pieces = [];
  for (const endOffsetMs of [7 / 24, 13.5, 33.125, 99, 100])
    pieces.push(bytes(split.flush({ ...all, endOffsetMs })));
  expect(Buffer.concat(pieces)).toEqual(bytes(whole.flush(all)));
  expect(split.bufferedByteLength).toBe(0);
});

test("bounds storage and output allocation without consuming data on failure", () => {
  const audio = new PcmBuffer({
    sampleRate: 1000,
    channels: 1,
    maxBufferBytes: 4,
  });
  audio.write(new Int16Array([1, 2]), mono(1000));
  expect(() => audio.write(new Int16Array([3]), mono(1000, 2))).toThrow(
    "capture_byte_limit",
  );
  expect(audio.bufferedByteLength).toBe(4);
  expect(samples(bytes(audio.flush(all)))).toEqual([1, 2]);
  audio.write(new Int16Array([7]), mono(1000, 1000000));
  expect(() => audio.flush(all)).toThrow("capture_byte_limit");
  expect(audio.flush({ ...all, endOffsetMs: 1000000 })).toBeUndefined();
  expect(samples(bytes(audio.flush(all)))).toEqual([7]);
});

test("rejects invalid formats, incomplete frames, cuts and byte limits", () => {
  expect(() => new PcmBuffer({ sampleRate: 0, channels: 1 })).toThrow();
  expect(() => new PcmBuffer({ sampleRate: 24000, channels: 0 })).toThrow();
  const audio = new PcmBuffer({ sampleRate: 24000, channels: 2 });
  const stereo = { sampleRate: 24000, channels: 2, channel: 0, offsetMs: 0 };
  expect(() => audio.write(new Int16Array([1]), stereo)).toThrow(
    "incomplete_pcm_frame",
  );
  expect(() =>
    audio.write(new Int16Array([1, 2]), { ...stereo, channel: 2 }),
  ).toThrow("unsupported_audio_format");
  expect(() =>
    audio.write(new Int16Array([1, 2]), { ...stereo, offsetMs: NaN }),
  ).toThrow("unsupported_audio_format");
  audio.write(new Int16Array([1, 2]), stereo);
  for (const endOffsetMs of [1000, -1])
    expect(() => audio.flush({ ...all, endOffsetMs })).toThrow(
      "invalid_digest_offset",
    );
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, MAX + 1])
    expect(() => audio.flush({ maxBytes })).toThrow(
      "invalid_digest_byte_limit",
    );
  expect(audio.bufferedByteLength).toBe(2);
});

test("byte-limited flushes wait for confirmed full chunks and flush a final remainder", () => {
  const audio = new PcmBuffer({ sampleRate: 1000, channels: 2 });
  const source = Int16Array.from({ length: 6 }, (_, i) => i + 1);
  audio.write(source, mono(1000));
  expect(audio.flush({ maxBytes: 8, endOffsetMs: 1 })).toBeUndefined();
  const first = audio.flush({ maxBytes: 8, endOffsetMs: 3 });
  expect(first).toMatchObject({ startOffsetMs: 0, endOffsetMs: 2 });
  expect(audio.flush({ maxBytes: 8, endOffsetMs: 3 })).toBeUndefined();
  const second = audio.flush({ maxBytes: 8, endOffsetMs: 3, partial: true });
  expect(second).toMatchObject({ startOffsetMs: 2, endOffsetMs: 3 });
  const third = audio.flush({ maxBytes: 8 });
  expect(audio.flush({ maxBytes: 8 })).toBeUndefined();
  const last = audio.flush({ maxBytes: 8, partial: true });
  const data = Buffer.concat([first, second, third, last].map(bytes));
  expect(samples(data)).toEqual([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]);
  expect(audio.bufferedByteLength).toBe(0);
});

test.each([
  { channels: 1, maxBytes: 1, sizes: [2, 2, 2, 2, 2] },
  { channels: 2, maxBytes: 9, sizes: [8, 8, 4] },
  { channels: 3, maxBytes: 13, sizes: [12, 12, 6] },
])(
  "byte limits align to complete frames for $channels channels",
  ({ channels, maxBytes, sizes }) => {
    const audio = new PcmBuffer({ sampleRate: 1000, channels });
    audio.write(new Int16Array([1, 2, 3, 4, 5]), mono(1000));
    const files: Buffer[] = [];
    while (audio.bufferedByteLength)
      files.push(bytes(audio.flush({ maxBytes, partial: true })));
    expect(files.map((f) => f.length)).toEqual(sizes);
  },
);

test("byte-limited flushes skip empty intervals and retain silence inside a file", () => {
  const audio = new PcmBuffer({ sampleRate: 1000, channels: 1 });
  audio.write(new Int16Array([7]), mono(1000, 5));
  audio.write(new Int16Array([9]), mono(1000, 8));
  const first = audio.flush({ maxBytes: 4 });
  expect(first).toMatchObject({ startOffsetMs: 4, endOffsetMs: 6 });
  expect(samples(bytes(first))).toEqual([0, 7]);
  expect(audio.flush({ maxBytes: 4 })).toBeUndefined();
  const last = audio.flush({ maxBytes: 4, partial: true });
  expect(last).toMatchObject({ startOffsetMs: 8, endOffsetMs: 9 });
  expect(samples(bytes(last))).toEqual([9]);
});
