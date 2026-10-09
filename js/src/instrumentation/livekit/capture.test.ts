/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createRecording,
  timeline,
  type RecordingOptions,
} from "../../../../integrations/audio/src/index";
import * as audioWorker from "../../../../integrations/audio/src/worker";
import { encodeCall } from "../../../../integrations/audio/src/pcm";
import { mergeSelections } from "../../../../integrations/audio/src/selections";
import { instrumentInput, instrumentOutput, release } from "./capture";
import type { Capture } from "./runtime";
type AudioFile = { bytes: Uint8Array; durationMs: number };
const captures: Capture[] = [];
beforeEach(() => {
  // Core-only test jobs do not build the optional audio worker. Keep real WAV
  // encoding here; worker execution is covered by audio tests and LiveKit E2E.
  vi.spyOn(audioWorker, "createEncoder").mockReturnValue(
    async (packets, durationMs) => ({
      ...encodeCall(packets, durationMs),
      mimeType: "audio/wav",
      sampleRate: 24000,
    }),
  );
});
function capture(
  options: RecordingOptions = {},
): Capture & { files: AudioFile[] } {
  const files: AudioFile[] = [];
  const c: Capture & { files: AudioFile[] } = {
    files,
    timeline,
    session: {
      activity: {
        currentSpeech: {
          _agentTurnSpan: { spanContext: () => ({ spanId: "turn" }) },
        },
      },
    },
    row: { span: { spanId: "session" } } as any,
    user: true,
    agent: true,
    origin: Date.now() - 100,
    recording: createRecording({
      options,
      audioFormat: "wav",
      span: { spanId: "session", log: () => {} },
      flush: async () => {},
      snapshot: () => ({
        origin: c.origin,
        basis: "test",
        source: (channel_index) => ({ channel_index }),
      }),
      turnSelections: () => [],
      createAttachment: ({ data }) => ({
        reference: {},
        upload: async () => {
          files.push({ bytes: data, durationMs: (data.length - 44) / 96 });
          return { upload_status: "done" };
        },
      }),
    }),
    inputTimeline: [],
    inputDurationMs: 0,
    outputHolds: new Map(),
    closed: false,
    selections: new Map(),
    events: new Map(),
    cleanups: [],
  };
  captures.push(c);
  return c;
}
const frame = (samples = 480, value = 1234) => ({
  data: new Int16Array(samples).fill(value),
  sampleRate: 24000,
  channels: 1,
});
afterEach(async () => {
  for (const c of captures.splice(0)) {
    for (const f of c.cleanups) f();
    await c.recording.finish();
    release(c);
  }
  vi.restoreAllMocks();
});
test("input tap preserves read values, cancellation and locks; copies mutable PCM", async () => {
  const c = capture(),
    f = frame();
  let cancelled = false;
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(f);
    },
    cancel() {
      cancelled = true;
    },
  });
  instrumentInput(c, stream);
  const reader = stream.getReader();
  expect((await reader.read()).value).toBe(f);
  f.data.fill(0);
  await c.recording.finish();
  expect(
    new DataView(c.files[0].bytes.buffer).getInt16(
      c.files[0].bytes.length - 4,
      true,
    ),
  ).toBe(1234);
  await reader.cancel();
  reader.releaseLock();
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
test("disabled capture does not wrap input or output", () => {
  const c = capture({ segmentDurationSeconds: 0.02 });
  c.user = false;
  c.agent = false;
  const stream = new ReadableStream(),
    getReader = stream.getReader;
  const sink = new EventEmitter() as any;
  sink.captureFrame = async () => {};
  const original = sink.captureFrame;
  instrumentInput(c, stream);
  instrumentOutput(c, sink, false);
  expect(stream.getReader).toBe(getReader);
  expect(sink.captureFrame).toBe(original);
});
test("interruption includes only sink progress ranges, excluding queued tail and pauses", async () => {
  const c = capture(),
    sink = new EventEmitter() as any;
  sink.captureFrame = async () => {};
  sink.flush = () => {};
  sink.clearBuffer = () => {};
  instrumentOutput(c, sink, false);
  await sink.captureFrame(frame(2400)); // 100ms generated
  sink.emit("playbackProgressed", {
    startedAt: c.origin + 10,
    offset: 0,
    duration: 20,
  });
  sink.emit("playbackProgressed", {
    startedAt: c.origin + 60,
    offset: 40,
    duration: 20,
  });
  sink.emit("playbackFinished", {
    playbackPosition: 0.04,
    interrupted: true,
    synchronizedTranscript: "private",
  });
  const ranges = mergeSelections(c.selections.get("turn")!);
  expect(ranges.map((s) => [s.start_offset_ms, s.end_offset_ms])).toEqual([
    [10, 30],
    [60, 80],
  ]);

  expect(
    c.events.get("turn")![0].attributes.synchronizedTranscript,
  ).toBeUndefined();
  await c.recording.finish();
  const wav = c.files[0];
  expect(wav.durationMs).toBe(80);
  const view = new DataView(wav.bytes.buffer);
  expect(view.getUint16(22, true)).toBe(2);
  expect(view.getInt16(44 + 240 * 4 + 2, true)).toBe(1234);
  expect(view.getInt16(44 + 960 * 4 + 2, true)).toBe(0);
});
test("synchronous completion during an in-flight capture is settled after acceptance", async () => {
  const c = capture(),
    sink = new EventEmitter() as any;
  sink.captureFrame = async () => {
    sink.emit("playbackStarted", { createdAt: c.origin + 10 });
    sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
  };
  instrumentOutput(c, sink, true);
  await sink.captureFrame(frame());
  await c.recording.finish();
  expect(c.files).toHaveLength(1);
  expect(c.selections.get("turn")![0].end_offset_ms).toBe(30);
});
test("failed capture preserves the original exception and cannot claim retained output", async () => {
  const c = capture(),
    sink = new EventEmitter() as any,
    error = new Error("sink failure");
  sink.captureFrame = async () => {
    throw error;
  };
  instrumentOutput(c, sink, false);
  await expect(sink.captureFrame(frame())).rejects.toBe(error);
  expect(c.recording.reason).toBe("output_capture_failed");
  await c.recording.finish();
  expect(c.files).toHaveLength(0);
});
test("unknown interrupted playout is omitted rather than guessed from span timestamps", async () => {
  const c = capture(),
    sink = new EventEmitter() as any;
  sink.captureFrame = async () => {};
  instrumentOutput(c, sink, false);
  await sink.captureFrame(frame());
  sink.emit("playbackFinished", { playbackPosition: 0.01, interrupted: true });
  expect(c.recording.reason).toBe("output_playout_mapping_unavailable");
});
test("byte budget stops capture and releases staged output without changing I/O", async () => {
  const c = capture({ maxBufferBytes: 960 }),
    sink = new EventEmitter() as any;
  let accepted = 0;
  sink.captureFrame = async () => {
    accepted++;
  };
  instrumentOutput(c, sink, false);
  await sink.captureFrame(frame());
  await sink.captureFrame(frame());
  expect(accepted).toBe(2);
  expect(c.recording.reason).toBe("capture_byte_limit");
  sink.emit("playbackFinished", { playbackPosition: 0.04, interrupted: false });
  await c.recording.finish();
  expect(c.files).toHaveLength(0);
});
test("buffered input frames retain all samples instead of overwriting equal arrival times", async () => {
  const c = capture();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(frame(480, 1000));
      controller.enqueue(frame(480, 2000));
      controller.close();
    },
  });
  instrumentInput(c, stream);
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  reader.releaseLock();
  await c.recording.finish();
  const wav = c.files[0],
    view = new DataView(wav.bytes.buffer);
  const last = wav.bytes.length - 4;
  expect(view.getInt16(last, true)).toBe(2000);
  expect(view.getInt16(last - 480 * 4, true)).toBe(1000);
});
test("input source replacement is explicit and concurrent sessions cannot steal capture", () => {
  const a = capture(),
    b = capture();
  const stream = new ReadableStream();
  instrumentInput(a, stream);
  instrumentInput(b, stream);
  expect(a.recording.reason).toBe("shared_input_unsupported");
  expect(b.recording.reason).toBe("shared_input_unsupported");
  const c = capture();
  instrumentInput(c, new ReadableStream());
  instrumentInput(c, new ReadableStream());
  expect(c.recording.reason).toBe("input_source_change_unsupported");
});

test("confirmed playback rotates during a still-open utterance and interruption discards only its queued tail", async () => {
  const c = capture({ segmentDurationSeconds: 0.02 });
  c.user = false;
  c.origin = Date.now() - 5000;
  const sink = new EventEmitter() as any;
  sink.captureFrame = async () => {};
  instrumentOutput(c, sink, false);
  await sink.captureFrame(frame());
  sink.emit("playbackProgressed", {
    startedAt: c.origin,
    offset: 0,
    duration: 20,
  });
  await c.recording.drain();
  expect(c.files).toMatchObject([{ durationMs: 20 }]);
  expect(c.closed).toBe(false);
  await sink.captureFrame(frame());
  sink.emit("playbackFinished", { playbackPosition: 0.02, interrupted: true });
  await c.recording.finish();
  expect(c.files).toMatchObject([{ durationMs: 20 }]);
  expect(c.selections.get("turn")).toMatchObject([
    { start_offset_ms: 0, end_offset_ms: 20 },
  ]);
});

test("continuous input uses sample time despite late delivery and preserves actual silent samples", async () => {
  let now = 10020;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const c = capture();
  c.origin = 10000;
  const stream = new ReadableStream({
    start(controller) {
      for (const value of [1234, 0, 2345])
        controller.enqueue(frame(480, value));
      controller.close();
    },
  });
  try {
    instrumentInput(c, stream);
    const reader = stream.getReader();
    for (const time of [10020, 10041, 10062]) {
      now = time;
      await reader.read();
    }
    reader.releaseLock();
    await c.recording.finish();
    const wav = new DataView(c.files[0].bytes.buffer);
    expect((c.files[0].bytes.length - 44) / 4).toBe(1440);
    for (let i = 0; i < 1440; i++)
      expect(wav.getInt16(44 + i * 4, true)).toBe(
        i < 480 ? 1234 : i < 960 ? 0 : 2345,
      );
  } finally {
    clock.mockRestore();
  }
});

test("shared output stops both recordings without changing application playback", async () => {
  const a = capture(),
    b = capture();
  a.user = b.user = false;
  const sink = new EventEmitter() as any;
  const delivered: unknown[] = [];
  sink.captureFrame = async (value: unknown) => {
    delivered.push(value);
    return "played";
  };
  instrumentOutput(a, sink, false);
  instrumentOutput(b, sink, false);
  const audio = frame();
  expect(await sink.captureFrame(audio)).toBe("played");
  sink.emit("playbackFinished", { playbackPosition: 0.02, interrupted: false });
  await Promise.all([a.recording.finish(), b.recording.finish()]);
  expect(delivered).toEqual([audio]);
  expect(a.files).toEqual([]);
  expect(b.files).toEqual([]);
  expect(a.recording.reason).toBe("shared_output_unsupported");
  expect(b.recording.reason).toBe("shared_output_unsupported");
});

test("multiple playback runs in one assistant turn keep selections on each speaking span", async () => {
  const c = capture();
  const sink = Object.assign(new EventEmitter(), {
    captureFrame: async (_frame: unknown) => {},
    flush() {},
  });
  instrumentOutput(c, sink, false);
  for (const [id, start] of [
    ["ack", 10],
    ["answer", 100],
  ] as const) {
    c.session.agentSpeakingSpan = { spanContext: () => ({ spanId: id }) };
    await sink.captureFrame(frame(480));
    sink.emit("playbackProgressed", {
      startedAt: c.origin + start,
      offset: 0,
      duration: 20,
    });
    sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
    sink.flush();
  }
  expect(c.selections.get("ack")).toMatchObject([
    { start_offset_ms: 10, end_offset_ms: 30 },
  ]);
  expect(c.selections.get("answer")).toMatchObject([
    { start_offset_ms: 100, end_offset_ms: 120 },
  ]);
  expect(c.selections.get("turn")).toHaveLength(2);
});
