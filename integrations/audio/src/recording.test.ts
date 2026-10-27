import { expect, test, vi } from "vitest";
import { createRecording, type RecordingConfig, type Selection } from "./index";

test.each(["wav", "ogg"] as const)(
  "public recording API exports %s only after upload succeeds",
  async (audioFormat) => {
    const log = vi.fn();
    const flush = vi.fn(async () => {});
    let complete!: () => void;
    let started!: () => void;
    const uploading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const uploaded = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const createAttachment = vi.fn(
      (options: {
        data: Uint8Array;
        filename: string;
        contentType: string;
      }) => ({
        reference: {
          key: "uploaded",
          filename: options.filename,
          content_type: options.contentType,
        },
        upload: async () => {
          started();
          await uploaded;
          return { upload_status: "done" };
        },
      }),
    );
    const recording = createRecording({
      audioFormat,
      // Explicit undefined must behave like an omitted optional setting.
      options: {
        segmentDurationSeconds: undefined,
        maxDurationSeconds: undefined,
        maxBufferBytes: undefined,
        flushFraction: undefined,
      },
      span: { spanId: "call", log },
      flush,
      createAttachment,
      snapshot: () => ({
        origin: 1234,
        basis: "test",

        source: (channel_index) => ({ channel_index }),
      }),
      turnSelections: () => [],
    });
    recording.record({
      pcm: new Int16Array(480).fill(1000),
      at: 0,
      rate: 24000,
      channels: 1,
      channel: 0,
    });
    const finishing = recording.finish();
    try {
      await uploading;
      recording.publishRecordings();
      expect(
        log.mock.calls
          .flatMap(([row]) => row.metadata?.["audio.recordings"] ?? [])
          .every((r) => r.state === "pending"),
      ).toBe(true);
      expect(log.mock.calls.some(([row]) => row.input?.audio)).toBe(false);
      const file = createAttachment.mock.calls[0][0];
      expect(Buffer.from(file.data.subarray(0, 4)).toString()).toBe(
        audioFormat === "wav" ? "RIFF" : "OggS",
      );
      expect(file.contentType).toBe(`audio/${audioFormat}`);
      complete();
      await finishing;
      expect(
        log.mock.calls
          .flatMap(([row]) => row.metadata?.["audio.recordings"] ?? [])
          .at(-1),
      ).toMatchObject({ state: "ready", mime_type: `audio/${audioFormat}` });
      expect(flush).toHaveBeenCalled();
    } finally {
      complete();
      await finishing;
    }
  },
);

test.each(["pending", "attachment", "manifest", "selection", "flush"])(
  "%s publication failure preserves uploaded audio and subsequent capture",
  async (failure) => {
    const rows: Parameters<RecordingConfig["span"]["log"]>[0][] = [];
    const audioKeys = (row: (typeof rows)[number]) =>
      row.input && typeof row.input === "object" && "audio" in row.input
        ? Object.keys(row.input.audio as object)
        : [];
    let fail = true;
    const rejectOnce = (stage: string) => {
      if (stage === failure && fail) {
        fail = false;
        throw new Error("temporary trace failure");
      }
    };
    const log = (row: (typeof rows)[number]) => {
      if (audioKeys(row).length) {
        rejectOnce("attachment");
      }
      const manifest = row.metadata?.["audio.recordings"];
      if (Array.isArray(manifest)) {
        const ready = manifest.some(
          (s: { state: string }) => s.state === "ready",
        );
        rejectOnce(ready ? "manifest" : "pending");
      }
      if (row.metadata?.["audio.selections"]) {
        rejectOnce("selection");
      }
      rows.push(row);
    };
    const turn = { log };
    const upload = vi.fn(async () => ({ upload_status: "done" }));
    const recording = createRecording({
      audioFormat: "wav",
      options: { segmentDurationSeconds: 0.02 },
      span: { spanId: "session", log },
      flush: async () => {
        // A rejected flush need not have delivered the queued trace updates.
        if (failure === "flush" && fail) {
          rows.length = 0;
        }
        rejectOnce("flush");
      },
      createAttachment: ({ filename }) => ({
        reference: { key: filename },
        upload,
      }),
      snapshot: () => ({
        origin: 0,
        basis: "test",

        source: (channel_index) => ({ channel_index }),
      }),
      turnSelections: () => [
        {
          span: turn,
          intervals: [
            {
              recording_span_id: "session",
              recording_id: "call",
              channel_index: 0,
              start_offset_ms: 0,
              end_offset_ms: 40,
            },
          ],
        },
      ],
    });
    try {
      for (const at of [0, 20]) {
        expect(
          recording.record({
            pcm: new Int16Array(480),
            at,
            rate: 24000,
            channels: 1,
            channel: 0,
          }),
        ).toBe(true);
        expect(() => recording.advance(at + 20)).not.toThrow();
        await recording.drain();
        expect(rows.flatMap(audioKeys)).toContain(
          at === 0 ? "call-0000" : "call-0001",
        );
        const selected = rows
          .filter((r) => r.metadata?.["audio.selections"])
          .at(-1);
        expect(selected?.metadata?.["audio.selections"]).toHaveLength(
          at / 20 + 1,
        );
      }
    } finally {
      await recording.finish();
    }
    recording.publishRecordings();
    recording.publishSelections();
    expect(fail).toBe(false);
    expect(upload).toHaveBeenCalledTimes(2);
    const manifest = rows
      .flatMap((r) =>
        Array.isArray(r.metadata?.["audio.recordings"])
          ? r.metadata["audio.recordings"]
          : [],
      )
      .slice(-2);
    expect(manifest).toMatchObject([{ state: "ready" }, { state: "ready" }]);
    expect(new Set(rows.flatMap(audioKeys))).toEqual(
      new Set(["call-0000", "call-0001"]),
    );
    expect(rows.at(-1)?.metadata?.["audio.selections"]).toMatchObject([
      { recording_id: "call-0000" },
      { recording_id: "call-0001" },
    ]);
  },
);

test("staged audio is copied, can be discarded, and is bounded independently per recording", async () => {
  const source = new Int16Array(12 * 1024 * 1024);
  source[0] = 123;
  const recordings = Array.from({ length: 3 }, () =>
    createRecording({
      options: { maxBufferBytes: source.byteLength },
      span: { spanId: "session", log: () => {} },
      flush: async () => {},
      createAttachment: () => {
        throw new Error("Discarded audio must not upload");
      },
      snapshot: () => ({
        origin: 0,
        basis: "test",

        source: () => ({}),
      }),
      turnSelections: () => [],
    }),
  );
  try {
    // More than 64 MiB in aggregate must not trigger a hidden cross-session limit.
    const staged = recordings.map((recording) => recording.copy(source));
    expect(staged.every((pcm) => pcm?.[0] === 123)).toBe(true);
    source[0] = 456;
    for (const [index, recording] of recordings.entries()) {
      expect(staged[index]?.[0]).toBe(123);
      recording.release(staged[index]!);
    }
    // Discarding returns capacity; exceeding this recording's own limit stops capture.
    expect(recordings[0].copy(source)).toBeDefined();
    expect(recordings[0].copy(new Int16Array(1))).toBeUndefined();
    expect(recordings[0].reason).toBe("capture_byte_limit");
    expect(recordings[1].copy(new Int16Array(1))).toBeDefined();
    expect(recordings[1].reason).toBeUndefined();
  } finally {
    await Promise.all(recordings.map((recording) => recording.finish()));
  }
});

test("recording publication observes changed context and suppresses identical updates", async () => {
  const log = vi.fn();
  const metadata = { source: "microphone" };
  const recording = createRecording({
    span: { spanId: "session", log },
    flush: async () => {},
    createAttachment: () => {
      throw new Error("No audio captured");
    },
    snapshot: () => ({
      origin: 0,
      basis: "test",

      source: () => ({}),
      metadata,
    }),
    turnSelections: () => [],
  });
  recording.publishRecordings();
  recording.publishRecordings();
  expect(log).toHaveBeenCalledTimes(1);
  metadata.source = "replacement";
  recording.publishRecordings();
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls.at(-1)?.[0].metadata.source).toBe("replacement");
  await recording.finish();
});

test.each([undefined, "capture_byte_limit"])(
  "finish publishes final state without audio (reason=%s) and is idempotent",
  async (reason) => {
    const log = vi.fn();
    const flush = vi.fn(async () => {});
    const recording = createRecording({
      span: { spanId: "session", log },
      flush,
      createAttachment: () => {
        throw new Error("No audio to upload");
      },
      snapshot: () => ({ origin: 0, basis: "test", source: () => ({}) }),
      turnSelections: () => [],
    });
    recording.publishRecordings();
    if (reason) {
      recording.stop(reason);
    }
    await recording.finish();
    expect(
      log.mock.calls.at(-1)?.[0].metadata["audio.recordings"],
    ).toMatchObject([
      { state: "omitted", reason: reason ?? "no_audio_observed" },
    ]);
    const count = log.mock.calls.length;
    await recording.finish();
    expect(log).toHaveBeenCalledTimes(count);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(recording.copy(new Int16Array(1))).toBeUndefined();
  },
);

test("finish publishes late turn selections without uploading the segment again", async () => {
  const log = vi.fn();
  const turn = { log: vi.fn() };
  const upload = vi.fn(async () => ({ upload_status: "done" }));
  const intervals: Selection[] = [];
  const recording = createRecording({
    audioFormat: "wav",
    options: { segmentDurationSeconds: 0.02 },
    span: { spanId: "session", log },
    flush: async () => {},
    createAttachment: () => ({ reference: { key: "audio" }, upload }),
    snapshot: () => ({
      origin: 0,
      basis: "test",
      source: (channel_index) => ({ channel_index }),
    }),
    turnSelections: () => [{ span: turn, intervals }],
  });
  recording.record({
    pcm: new Int16Array(480),
    at: 0,
    rate: 24000,
    channels: 1,
    channel: 0,
  });
  recording.advance(20);
  await recording.drain();
  intervals.push({
    recording_span_id: "session",
    recording_id: "call",
    channel_index: 0,
    start_offset_ms: 0,
    end_offset_ms: 20,
  });
  await recording.finish();
  expect(turn.log.mock.calls.at(-1)?.[0].metadata["audio.selections"]).toEqual([
    {
      recording_span_id: "session",
      recording_id: "call-0000",
      channel_index: 0,
      start_offset_ms: 0,
      end_offset_ms: 20,
    },
  ]);
  expect(upload).toHaveBeenCalledTimes(1);
});
