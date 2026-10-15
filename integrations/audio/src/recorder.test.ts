import type { AudioSegment } from "./segment";
import { expect, test } from "vitest";
import { Recorder, type RecordingOptions } from "./recorder";
import { SegmentExporter, type Encoder } from "./exporter";
import type { EncodedAudio } from "./segment";
import { encodeCall } from "./pcm";
const encode = async (
  packets: Parameters<typeof encodeCall>[0],
  durationMs: number,
) => ({
  ...encodeCall(packets, durationMs),
  mimeType: "audio/wav",
  sampleRate: 24000,
});
// Exercise the recorder with real segment execution and in-memory remote storage.
function recording(
  options: RecordingOptions,
  encode: Encoder,
  publish: (s: AudioSegment) => Promise<void>,
) {
  let encoded: EncodedAudio;
  const exporter = new SegmentExporter(
    async (...args) => {
      encoded = await encode(...args);
      return encoded;
    },
    () => ({
      reference: encoded,
      upload: async () => ({ upload_status: "done" }),
    }),
  );
  return new Recorder(options, exporter, publish);
}
function accept(segment: AudioSegment) {
  return segment.attachmentReference as EncodedAudio | undefined;
}
function samples(value: number, seconds = 1) {
  return new Int16Array(24000 * seconds).fill(value);
}
test("exports progressively with bounded source memory across a ten minute timeline", async () => {
  const files: { start: number; bytes: Uint8Array }[] = [];
  const r = recording({ segmentDurationSeconds: 30 }, encode, async (s) => {
    const data = accept(s);
    if (data) {
      files.push({ start: s.start, bytes: data.bytes });
    }
  });
  for (let i = 0; i < 600; i++) {
    r.record({
      pcm: samples(1000),
      at: i * 1000,
      rate: 24000,
      channels: 1,
      channel: 0,
    });
    r.record({
      pcm: samples(-2000),
      at: i * 1000,
      rate: 24000,
      channels: 1,
      channel: 1,
    });
    r.advance((i + 1) * 1000);
    await r.drain();
    expect(r.retainedBytes).toBeLessThan(4 * 1024 * 1024);
  }
  expect(files.length).toBe(20);
  await r.finish();
  expect(r.retainedBytes).toBe(0);
  for (const [i, f] of files.entries()) {
    expect(f.start).toBe(i * 30000);
    const view = new DataView(f.bytes.buffer);
    expect(view.getInt16(44, true)).toBe(1000);
    expect(view.getInt16(f.bytes.length - 2, true)).toBe(-2000);
  }
});
test("splits a packet crossing the cut without losing its tail", async () => {
  const files: Uint8Array[] = [];
  const r = recording({ segmentDurationSeconds: 1 }, encode, async (s) => {
    const data = accept(s);
    if (data) {
      files.push(data.bytes);
    }
  });
  r.record({
    pcm: samples(321, 3),
    at: 0,
    rate: 24000,
    channels: 1,
    channel: 0,
  });
  r.advance(1000);
  await r.drain();
  await r.finish();
  expect(files.map((f) => (f.length - 44) / 4)).toEqual([24000, 24000, 24000]);
  expect(r.retainedBytes).toBe(0);
});
test("rotated files reconstruct both source channels sample-for-sample including a partial final file", async () => {
  const files: Uint8Array[] = [];
  const recorder = recording(
    { segmentDurationSeconds: 1 },
    encode,
    async (s) => {
      const data = accept(s);
      if (data) {
        files.push(data.bytes);
      }
    },
  );
  // Distinct nonconstant signals expose reordered, duplicated, or missing audio.
  const length = 3 * 24000 + 1777;
  const input = Int16Array.from(
    { length },
    (_, i) => ((i * 17) % 30001) - 15000,
  );
  const output = Int16Array.from(
    { length },
    (_, i) => ((i * 31) % 28001) - 14000,
  );
  // Packets deliberately cross the one-second file boundary.
  for (let at = 0; at < length; at += 719) {
    for (const [channel, source] of [input, output].entries()) {
      recorder.record({
        pcm: source.slice(at, at + 719),
        at: at / 24,
        rate: 24000,
        channels: 1,
        channel: channel as 0 | 1,
      });
    }
    recorder.advance(Math.min(at + 719, length) / 24);
    await recorder.drain();
  }
  await recorder.finish();
  expect(files.map((file) => (file.length - 44) / 4)).toEqual([
    24000, 24000, 24000, 1777,
  ]);
  const expected = Buffer.alloc(length * 4);
  for (let i = 0; i < length; i++) {
    expected.writeInt16LE(input[i], i * 4);
    expected.writeInt16LE(output[i], i * 4 + 2);
  }
  expect(
    Buffer.concat(files.map((file) => file.subarray(44))).equals(expected),
  ).toBe(true);
});

test("hard duration limit preserves the prefix and reports truncation", async () => {
  const r = recording({ maxDurationSeconds: 2 }, encode, async (s) => {
    accept(s);
  });
  for (let i = 0; i < 3; i++) {
    r.record({
      pcm: samples(1),
      at: i * 1000,
      rate: 24000,
      channels: 1,
      channel: 0,
    });
  }
  await r.finish();
  expect(r.reason).toBe("duration_limit");
  expect(r.segments[0]).toMatchObject({ state: "ready", end: 2000 });
  expect(r.retainedBytes).toBe(0);
});
test("slow publication bounds retained audio without erasing a completed segment", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((r) => {
    unblock = r;
  });
  const r = recording(
    { segmentDurationSeconds: 1, maxBufferBytes: 100000 },
    encode,
    async (s) => {
      await blocked;
      accept(s);
    },
  );
  r.record({ pcm: samples(1), at: 0, rate: 24000, channels: 1, channel: 0 });
  r.advance(1000);
  for (let i = 1; i < 8; i++) {
    r.record({
      pcm: samples(1),
      at: i * 1000,
      rate: 24000,
      channels: 1,
      channel: 0,
    });
  }
  expect(r.retainedBytes).toBeLessThanOrEqual(100000);
  expect(r.reason).toBe("capture_byte_limit");
  unblock();
  await r.finish();
  expect(r.segments.some((s) => s.state === "ready")).toBe(true);
  expect(r.retainedBytes).toBe(0);
});

test.each(["encoding", "publication"])(
  "%s failure retains earlier ready audio and releases source leases",
  async (failure) => {
    let count = 0,
      encodings = 0;
    const r = recording(
      { segmentDurationSeconds: 1 },
      async (...args) => {
        if (++encodings === 2 && failure === "encoding") {
          throw new Error("encode failed");
        }
        return encode(...args);
      },
      async (s) => {
        const data = accept(s);
        if (data && ++count === 2 && failure === "publication") {
          throw Error("export failed");
        }
      },
    );
    for (let i = 0; i < 2; i++) {
      r.record({
        pcm: samples(1),
        at: i * 1000,
        rate: 24000,
        channels: 1,
        channel: 0,
      });
      r.advance((i + 1) * 1000);
      await r.drain();
    }
    await r.finish();
    expect(r.segments.map((s) => s.state)).toEqual([
      "ready",
      failure === "encoding" ? "omitted" : "ready",
    ]);
    expect(r.retainedBytes).toBe(0);
  },
);

test("a watermark behind the current origin cannot move a segment backwards", async () => {
  const r = recording({ segmentDurationSeconds: 0.1 }, encode, async (s) => {
    accept(s);
  });
  r.record({ pcm: samples(1), at: 200, rate: 24000, channels: 1, channel: 0 });
  r.advance(500);
  await r.drain();
  expect(r.segments.map((s) => [s.start, s.end])).toEqual([
    [200, 300],
    [300, 400],
    [400, 500],
  ]);
  r.advance(100);
  await r.finish();
  expect(r.segments.map((s) => [s.start, s.end])).toEqual(
    Array.from({ length: 10 }, (_, i) => [200 + i * 100, 300 + i * 100]),
  );
});
test("soft byte pressure rotates before the duration threshold", async () => {
  const r = recording(
    { segmentDurationSeconds: 60, maxBufferBytes: 200000, flushFraction: 0.5 },
    encode,
    async (s) => {
      accept(s);
    },
  );
  for (let i = 0; i < 3; i++) {
    r.record({
      pcm: samples(1),
      at: i * 1000,
      rate: 24000,
      channels: 1,
      channel: 0,
    });
  }
  r.advance(2000);
  await r.drain();
  expect(r.segments[0]).toMatchObject({ state: "ready", end: 2000 });
  await r.finish();
  expect(r.retainedBytes).toBe(0);
});

test.each([1, 60])(
  "a delayed watermark drains %i-second clips before close without requiring more input",
  async (seconds) => {
    const durations: number[] = [];
    const r = recording(
      { segmentDurationSeconds: seconds },
      encode,
      async (s) => {
        const data = accept(s);
        if (data) {
          durations.push(data.durationMs);
        }
      },
    );
    for (let i = 0; i < 5 * seconds; i++) {
      r.record({
        pcm: samples(123),
        at: i * 1000,
        rate: 24000,
        channels: 1,
        channel: 0,
      });
    }
    r.advance(5000 * seconds);
    await r.drain();
    expect(durations).toEqual(Array(5).fill(1000 * seconds));
    await r.finish();
    expect(durations).toHaveLength(5);
  },
);
