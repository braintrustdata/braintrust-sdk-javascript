import { expect, test, vi } from "vitest";
import type { AudioMiddleware, AudioSegmentMeta } from "./audio-middleware";
import { AudioRecorder } from "./audio-recorder";

const mono = (offsetMs: number) => ({
  sampleRate: 1000,
  channelCount: 1,
  offsetMs,
});
const ramp = (length: number, from = 1) =>
  Int16Array.from({ length }, (_, i) => from + i);
const samples = (data: Uint8Array) =>
  Array.from(new Int16Array(data.slice().buffer));

/** A 1 kHz recorder with sources "a" and "b", collecting segments and errors. */
function recorder(
  options: Partial<ConstructorParameters<typeof AudioRecorder>[0]> = {},
) {
  const flushed: { segment: Uint8Array; meta: AudioSegmentMeta }[] = [];
  const errors: { meta: AudioSegmentMeta; reason: string }[] = [];
  const r = new AudioRecorder({
    sampleRate: 1000,
    sources: ["a", "b"],
    segmentBytes: 40, // 10 stereo frames: 10 ms.
    onFlush(segment, meta) {
      flushed.push({ segment, meta });
    },
    onError(meta, reason) {
      errors.push({ meta, reason });
    },
    ...options,
  });
  return { r, flushed, errors };
}

test("without middleware, segments carry the recorded PCM and its format and placement", async () => {
  const { r, flushed, errors } = recorder();
  // Leading silence is skipped in whole segments, so 20 ms starts the first one.
  expect(r.record("a", ramp(4), mono(20))).toBe(true);
  expect(r.record("b", Int16Array.from([-1, -2]), mono(21))).toBe(true);
  await r.finish();
  expect(errors).toEqual([]);
  expect(flushed).toHaveLength(1);
  expect(samples(flushed[0].segment)).toEqual([1, 0, 2, -1, 3, -2, 4, 0]);
  expect(flushed[0].meta).toEqual({
    index: 0,
    startOffsetMs: 20,
    durationMs: 4,
    sampleRate: 1000,
    channelCount: 2,
    sources: [
      { channel: 0, name: "a" },
      { channel: 1, name: "b" },
    ],
    mimeType: "audio/pcm",
    encoding: "s16le",
  });
});

test("segments wait for advance() and rotate at the segment size", async () => {
  const { r, flushed } = recorder();
  r.record("a", ramp(25), mono(0));
  r.advance(5);
  await Promise.resolve();
  expect(flushed).toEqual([]);
  r.advance(22);
  await vi.waitFor(() => expect(flushed).toHaveLength(2));
  expect(
    flushed.map(({ meta }) => [meta.startOffsetMs, meta.durationMs]),
  ).toEqual([
    [0, 10],
    [10, 10],
  ]);
  await r.finish();
  expect(
    flushed.map(({ meta }) => [
      meta.index,
      meta.startOffsetMs,
      meta.durationMs,
    ]),
  ).toEqual([
    [0, 0, 10],
    [1, 10, 10],
    [2, 20, 5],
  ]);
});

test("late writes behind the newest audio land in segments that have not been confirmed", async () => {
  const { r, flushed } = recorder();
  r.record("a", ramp(20), mono(0));
  r.advance(10);
  await vi.waitFor(() => expect(flushed).toHaveLength(1));
  // Output confirmed after input moved on, but still ahead of the confirmed offset.
  expect(r.record("b", Int16Array.from([-7, -8]), mono(12))).toBe(true);
  await r.finish();
  expect(samples(flushed[1].segment).slice(4, 8)).toEqual([13, -7, 14, -8]);
  expect(flushed[1].meta.sources.map((s) => s.name)).toEqual(["a", "b"]);
  expect(flushed[0].meta.sources).toEqual([{ channel: 0, name: "a" }]);
});

test("advance() drains confirmed audio without new writes", async () => {
  const { r, flushed } = recorder();
  r.record("a", ramp(30), mono(0));
  r.advance(30);
  await vi.waitFor(() => expect(flushed).toHaveLength(3));
  expect(r.active).toBe(true);
});

test("buffering stays bounded while advance() stalls", async () => {
  const { r, flushed } = recorder({ maxBufferBytes: 40 });
  for (let at = 0; at < 20; at += 5)
    expect(r.record("a", ramp(5), mono(at))).toBe(true);
  await Promise.resolve();
  expect(flushed).toEqual([]);
  expect(r.record("a", ramp(5), mono(20))).toBe(false);
  expect(r.reason).toBe("capture_byte_limit");
  await r.finish();
  expect(flushed.map(({ meta }) => meta.durationMs)).toEqual([10, 10]);
});

test("rotation and the final partial segment reconstruct both channels exactly", async () => {
  const { r, flushed } = recorder();
  const expected: number[] = [];
  for (let at = 0; at < 37; at += 3) {
    r.record("a", ramp(Math.min(3, 37 - at), at + 1), mono(at));
    r.record(
      "b",
      ramp(Math.min(3, 37 - at), at + 1).map((v) => -v),
      mono(at),
    );
    r.advance(at + 3);
  }
  for (let i = 0; i < 37; i++) expected.push(i + 1, -(i + 1));
  await r.finish();
  expect(flushed.flatMap(({ segment }) => samples(segment))).toEqual(expected);
  expect(flushed.map(({ meta }) => meta.durationMs)).toEqual([10, 10, 10, 7]);
  // Segments tile the timeline without gaps or overlaps.
  for (const [i, { meta }] of flushed.entries())
    if (i)
      expect(meta.startOffsetMs).toBe(
        flushed[i - 1].meta.startOffsetMs + flushed[i - 1].meta.durationMs,
      );
});

test("middleware output is flushed; a failing segment is omitted, stops capture and keeps earlier audio", async () => {
  let calls = 0;
  const failSecond: AudioMiddleware = (segment, meta, next) => {
    if (++calls === 2) throw new Error("boom");
    return next(segment, { ...meta, encoding: "tagged" });
  };
  const { r, flushed, errors } = recorder({ middleware: [failSecond] });
  r.record("a", ramp(30), mono(0));
  r.advance(30);
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(errors[0]).toMatchObject({
    meta: { index: 1, startOffsetMs: 10 },
    reason: "recording_transform_failed",
  });
  expect(r.reason).toBe("recording_transform_failed");
  expect(r.record("a", ramp(1), mono(40))).toBe(false);
  await r.finish();
  // Accepted audio after the failure still drains on finish.
  expect(flushed.map(({ meta }) => [meta.index, meta.encoding])).toEqual([
    [0, "tagged"],
    [2, "tagged"],
  ]);
});

test("a rejected flush is reported, stops capture and never rejects finish", async () => {
  const { r, errors } = recorder({
    onFlush: async () => {
      throw new Error("offline");
    },
  });
  r.record("a", Int16Array.from([1]), mono(0));
  await expect(r.finish()).resolves.toBeUndefined();
  expect(errors.map(({ reason }) => reason)).toEqual([
    "recording_export_failed",
  ]);
  expect(r.reason).toBe("recording_export_failed");
});

test("one segment is in flight; slow work bounds the backlog and keeps the accepted prefix", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: AudioMiddleware = async (segment, meta, next) => {
    await gate;
    return next(segment, meta);
  };
  // Room for 20 buffered samples; the in-flight segment sits outside the budget.
  const { r, flushed } = recorder({ middleware: [slow], maxBufferBytes: 40 });
  expect(r.record("a", ramp(10), mono(0))).toBe(true);
  r.advance(10);
  for (let at = 10; at < 30; at += 10) {
    expect(r.record("a", ramp(10), mono(at))).toBe(true);
    r.advance(at + 10);
  }
  expect(r.record("a", ramp(10), mono(30))).toBe(false);
  expect(r.reason).toBe("capture_byte_limit");
  release();
  await r.finish();
  expect(flushed.map(({ meta }) => meta.startOffsetMs)).toEqual([0, 10, 20]);
});

test("finish is idempotent and waits for flushes to settle", async () => {
  let settled = false;
  const { r } = recorder({
    onFlush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = true;
    },
  });
  r.record("a", Int16Array.from([1]), mono(0));
  const finishing = r.finish();
  expect(r.finish()).toBe(finishing);
  expect(r.closed).toBe(true);
  await finishing;
  expect(settled).toBe(true);
  expect(r.record("a", Int16Array.from([1]), mono(1))).toBe(false);
});

test("staged reservations share the buffer budget until released", async () => {
  const { r, flushed } = recorder({ maxBufferBytes: 16, segmentBytes: 16 });
  expect(r.reserve(12)).toBe(true);
  expect(r.record("a", ramp(2), mono(0))).toBe(true);
  expect(r.record("a", ramp(1), mono(2))).toBe(false);
  expect(r.reason).toBe("capture_byte_limit");
  await r.finish();
  expect(flushed.flatMap(({ segment }) => samples(segment))).toEqual([
    1, 0, 2, 0,
  ]);

  const released = recorder({ maxBufferBytes: 16, segmentBytes: 16 });
  expect(released.r.reserve(12)).toBe(true);
  released.r.release(12);
  expect(released.r.record("a", ramp(8), mono(0))).toBe(true);
  expect(released.r.reserve(1)).toBe(false);
});

test("the duration limit and invalid audio stop capture with a reason", async () => {
  const limited = recorder({ maxDurationMs: 10 });
  expect(limited.r.record("a", ramp(8), mono(0))).toBe(true);
  expect(limited.r.record("a", ramp(4), mono(8))).toBe(false);
  expect(limited.r.reason).toBe("duration_limit");
  await limited.r.finish();
  expect(limited.flushed[0].meta.durationMs).toBe(8);

  const invalid = recorder();
  expect(invalid.r.record("a", ramp(3), { ...mono(0), channelCount: 2 })).toBe(
    false,
  );
  expect(invalid.r.reason).toBe("incomplete_pcm_frame");
  invalid.r.stop("later");
  expect(invalid.r.reason).toBe("incomplete_pcm_frame");

  const unknown = recorder();
  expect(unknown.r.record("c", ramp(1), mono(0))).toBe(false);
  expect(unknown.r.reason).toBe("unknown_audio_source");
});

test("concurrent recorders with shared middleware keep their segments separate", async () => {
  const gates: (() => void)[] = [];
  const tag: AudioMiddleware = async (segment, meta, next) => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return next(segment, { ...meta, encoding: `tagged-${segment[0]}` });
  };
  const a = recorder({ middleware: [tag] });
  const b = recorder({ middleware: [tag] });
  a.r.record("a", ramp(15, 1), mono(0));
  b.r.record("a", ramp(15, 50), mono(0));
  const finishing = Promise.all([a.r.finish(), b.r.finish()]);
  // Release in reverse arrival order; each recorder still flushes in order.
  while (a.flushed.length + b.flushed.length < 4) {
    gates
      .splice(0)
      .reverse()
      .forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await finishing;
  expect(a.flushed.map(({ meta }) => [meta.index, meta.encoding])).toEqual([
    [0, "tagged-1"],
    [1, "tagged-11"],
  ]);
  expect(b.flushed.map(({ meta }) => [meta.index, meta.encoding])).toEqual([
    [0, "tagged-50"],
    [1, "tagged-60"],
  ]);
});
