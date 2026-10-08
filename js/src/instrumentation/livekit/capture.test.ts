import { SegmentExporter } from "../../../../integrations/audio/src/exporter";
import * as timeline from "../../../../integrations/audio/src/timeline";
import { mergeSelections } from "../../../../integrations/audio/src/selections";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { instrumentInput, instrumentOutput, release } from "./capture";
import {
  Recorder,
  type RecordingOptions,
} from "../../../../integrations/audio/src/recorder";
import type { EncodedAudio } from "../../../../integrations/audio/src/segment";
import type { Capture } from "./runtime";
import { encodeCall } from "../../../../integrations/audio/src/pcm";
const captures: Capture[] = [];
function capture(
  options: RecordingOptions = {},
): Capture & { files: EncodedAudio[]; recorder: Recorder } {
  const files: EncodedAudio[] = [];
  const c: Capture & { files: EncodedAudio[]; recorder: Recorder } = {
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
    recorder: new Recorder(
      options,
      new SegmentExporter(
        async (packets, durationMs) => ({
          ...encodeCall(packets, durationMs),
          mimeType: "audio/wav",
          sampleRate: 24000,
        }),
        ({ data }) => ({
          reference: {},
          upload: async () => {
            files.push({
              bytes: data,
              durationMs: (data.length - 44) / 96,
              mimeType: "audio/wav",
              sampleRate: 24000,
            });
            return { upload_status: "done" };
          },
        }),
      ),
      async () => {},
    ),
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
    await c.recorder.finish();
    release(c);
  }
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
  await c.recorder.finish();
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
  await c.recorder.finish();
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
  await c.recorder.finish();
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
  expect(c.recorder.reason).toBe("output_capture_failed");
  await c.recorder.finish();
  expect(c.files).toHaveLength(0);
});
test("unknown interrupted playout is omitted rather than guessed from span timestamps", async () => {
  const c = capture(),
    sink = new EventEmitter() as any;
  sink.captureFrame = async () => {};
  instrumentOutput(c, sink, false);
  await sink.captureFrame(frame());
  sink.emit("playbackFinished", { playbackPosition: 0.01, interrupted: true });
  expect(c.recorder.reason).toBe("output_playout_mapping_unavailable");
});
test("worker preserves channel separation and frame duration at different rates", () => {
  const result = encodeCall([
    {
      pcm: new Int16Array(160).fill(1000),
      rate: 8000,
      channels: 1,
      channel: 0,
      at: 0,
    },
    {
      pcm: new Int16Array(960).fill(-1000),
      rate: 48000,
      channels: 1,
      channel: 1,
      at: 0,
    },
  ]);
  expect(result.durationMs).toBe(20);
  const view = new DataView(result.bytes.buffer);
  expect(view.getInt16(44, true)).toBe(1000);
  expect(view.getInt16(46, true)).toBe(-1000);
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
  expect(c.recorder.reason).toBe("capture_byte_limit");
  sink.emit("playbackFinished", { playbackPosition: 0.04, interrupted: false });
  await c.recorder.finish();
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
  await c.recorder.finish();
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
  expect(a.recorder.reason).toBe("shared_input_unsupported");
  expect(b.recorder.reason).toBe("shared_input_unsupported");
  const c = capture();
  instrumentInput(c, new ReadableStream());
  instrumentInput(c, new ReadableStream());
  expect(c.recorder.reason).toBe("input_source_change_unsupported");
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
  await c.recorder.drain();
  expect(c.recorder.segments).toMatchObject([{ state: "ready", end: 20 }]);
  expect(c.closed).toBe(false);
  expect(c.recorder.retainedBytes).toBe(0);
  await sink.captureFrame(frame());
  sink.emit("playbackFinished", { playbackPosition: 0.02, interrupted: true });
  expect(c.recorder.retainedBytes).toBe(0);
  expect(c.selections.get("turn")).toMatchObject([
    { start_offset_ms: 0, end_offset_ms: 20 },
  ]);
});

test("continuous input uses sample time despite late delivery and preserves actual silent samples", async () => {
  let now = 10020;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const files: Uint8Array[] = [];
  const c = capture();
  c.origin = 10000;
  c.recorder = new Recorder(
    {},
    new SegmentExporter(
      async (packets, durationMs) => ({
        ...encodeCall(packets, durationMs),
        mimeType: "audio/wav",
        sampleRate: 24000,
      }),
      ({ data }) => ({
        reference: {},
        upload: async () => {
          files.push(data);
          return { upload_status: "done" };
        },
      }),
    ),
    async () => {},
  );
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
    await c.recorder.finish();
    const wav = new DataView(files[0].buffer);
    expect((files[0].length - 44) / 4).toBe(1440);
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
  await Promise.all([a.recorder.finish(), b.recorder.finish()]);
  expect(delivered).toEqual([audio]);
  expect(a.files).toEqual([]);
  expect(b.files).toEqual([]);
  expect(a.recorder.reason).toBe("shared_output_unsupported");
  expect(b.recorder.reason).toBe("shared_output_unsupported");
});
