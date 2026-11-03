import { expect, test, vi } from "vitest";
import { AudioSessionRecorder, type AudioFile } from "./audio-session-recorder";

const SOURCES = {
  mic: { label: "User audio" },
  speaker: { label: "Agent audio" },
};
/** 1 kHz recordings with 100 ms (200 byte stereo) segments; records every file handed off. */
function recorder(
  store: (file: AudioFile) => Promise<void> = async () => {},
  audio = { sampleRate: 1000, segmentBytes: 400 },
) {
  const files: AudioFile[] = [];
  const audioSession = new AudioSessionRecorder({
    origin: 1_790_000_000_000,
    sources: SOURCES,
    audio,
    onFile: async (file) => {
      await store(file);
      files.push(file);
    },
  });
  return { audioSession, files };
}
const mono = (offsetMs: number) => ({
  sampleRate: 1000,
  channelCount: 1,
  offsetMs,
});
const ramp = (length: number) => Int16Array.from({ length }, (_, i) => i + 1);
/** Every segment entry handed off, merged in order as a session span would. */
const segments = (files: AudioFile[]) =>
  Object.assign(
    {},
    ...files.map(
      (file) => file.metadata["audio.segments"] as Record<string, unknown>,
    ),
  );

test("describes a session without audio: schema, sources and timeline, and no files", async () => {
  const onFile = vi.fn();
  const audioSession = new AudioSessionRecorder({
    origin: 5,
    sources: SOURCES,
    onFile,
  });
  expect(audioSession.session()).toEqual({
    "audio.schema.version": "3.0.0",
    "audio.sources": SOURCES,
    "audio.timeline": { origin_unix_ms: 5 },
  });
  expect(audioSession.record("mic", ramp(10), mono(0))).toBe(false);
  expect(audioSession.active).toBe(false);
  await audioSession.finish();
  expect(onFile).not.toHaveBeenCalled();
});

test("a participant's entry is returned on first sight only; its ID is stable", () => {
  const { audioSession } = recorder();
  const caller = {
    type: "user" as const,
    attributes: { "contrib.example.id": "PA_caller" },
  };
  expect(audioSession.participant("PA_caller", caller)).toEqual({
    id: "participant-1",
    added: { "audio.participants": { "participant-1": caller } },
  });
  expect(audioSession.participant("PA_agent", { type: "agent" }).added).toEqual(
    { "audio.participants": { "participant-2": { type: "agent" } } },
  );
  // Seen again: the same ID, and nothing new to publish.
  expect(audioSession.participant("PA_caller", caller)).toEqual({
    id: "participant-1",
  });
});

test("speakers are scoped to their source and kept apart from participants", () => {
  const { audioSession } = recorder();
  const voice = (source: string, nativeId: string) =>
    audioSession.speaker(source, nativeId, { type: "user" });
  expect(voice("mic", "0")).toEqual({
    id: "speaker-1",
    added: { "audio.speakers": { "speaker-1": { type: "user" } } },
  });
  expect(voice("mic", "1").id).toBe("speaker-2");
  expect(voice("mic", "0")).toEqual({ id: "speaker-1" });
  // The same label on another source is a different voice.
  expect(voice("speaker", "0").id).toBe("speaker-3");
  // A participant with the same native ID is a different member.
  expect(audioSession.participant("0", { type: "user" }).id).toBe(
    "participant-1",
  );
});

test("each recorded file is handed off with its ready entry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { audioSession, files } = recorder(() => gate);
  audioSession.record("mic", ramp(150), mono(0));
  audioSession.record("speaker", ramp(150), mono(0));
  audioSession.advance(150);
  const finishing = audioSession.finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Nothing is described before it is stored.
  expect(files).toEqual([]);
  release();
  await finishing;
  expect(files.map((f) => [f.id, f.mimeType, f.data?.byteLength])).toEqual([
    ["part-0", "audio/pcm", 400],
    ["part-1", "audio/pcm", 200],
  ]);
  expect(files[0].metadata).toEqual({
    "audio.segments": {
      "part-0": {
        state: "ready",
        start_offset_ms: 0,
        duration_ms: 100,
        attachment: { ref: "/input/audio/part-0" },
        mime_type: "audio/pcm",
        encoding: "pcm",
        sample_rate_hz: 1000,
        channels: { "0": { sources: ["mic"] }, "1": { sources: ["speaker"] } },
        attributes: {
          "pcm.sample_format": "s16le",
          "pcm.channel_layout": "interleaved",
        },
      },
    },
  });
  // The final partial segment.
  expect(segments(files)["part-1"]).toMatchObject({
    state: "ready",
    start_offset_ms: 100,
    duration_ms: 50,
  });
});

test("whole-millisecond segments tile without drift", async () => {
  // 24 kHz, 1001 frames per segment: 41.708… ms each.
  const { audioSession, files } = recorder(undefined, {
    sampleRate: 24000,
    segmentBytes: 1001 * 4,
  });
  audioSession.record("mic", ramp(1001 * 5), {
    sampleRate: 24000,
    channelCount: 1,
    offsetMs: 0,
  });
  await audioSession.finish();
  const placed = Object.values(segments(files)) as {
    start_offset_ms: number;
    duration_ms: number;
  }[];
  expect(placed).toHaveLength(5);
  for (let i = 1; i < placed.length; i++)
    expect(placed[i].start_offset_ms).toBe(
      placed[i - 1].start_offset_ms + placed[i - 1].duration_ms,
    );
  expect(placed.at(-1)!.start_offset_ms + placed.at(-1)!.duration_ms).toBe(
    Math.round((1001 * 5) / 24),
  );
});

test("a failed store is offered again as omitted and stops new audio; accepted audio still stores", async () => {
  let calls = 0;
  const offered: AudioFile[] = [];
  const audioSession = new AudioSessionRecorder({
    origin: 0,
    sources: SOURCES,
    audio: { sampleRate: 1000, segmentBytes: 400 },
    onFile: async (file) => {
      offered.push(file);
      if (file.data && ++calls === 2) throw new Error("offline");
    },
  });
  audioSession.record("mic", ramp(300), mono(0));
  audioSession.advance(300);
  await audioSession.finish();
  expect(offered.map((f) => [f.id, f.data !== undefined])).toEqual([
    ["part-0", true],
    ["part-1", true],
    ["part-1", false],
    ["part-2", true],
  ]);
  expect(offered[2].metadata).toEqual({
    "audio.segments": {
      "part-1": {
        state: "omitted",
        start_offset_ms: 100,
        duration_ms: 100,
        reason: "recording_export_failed",
      },
    },
  });
  expect(audioSession.reason).toBe("recording_export_failed");
  expect(audioSession.record("mic", ramp(10), mono(300))).toBe(false);
});

test("failing middleware omits the segment with the recorder's reason", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const files: AudioFile[] = [];
  const audioSession = new AudioSessionRecorder({
    origin: 0,
    sources: SOURCES,
    audio: {
      sampleRate: 1000,
      segmentBytes: 400,
      middleware: [
        () => {
          throw new Error("encoder unavailable");
        },
      ],
    },
    onFile: async (file) => void files.push(file),
  });
  audioSession.record("mic", ramp(50), mono(0));
  await audioSession.finish();
  expect(files).toEqual([
    {
      id: "part-0",
      metadata: {
        "audio.segments": {
          "part-0": {
            state: "omitted",
            start_offset_ms: 0,
            duration_ms: 50,
            reason: "recording_transform_failed",
          },
        },
      },
    },
  ]);
  vi.restoreAllMocks();
});

test("finish is idempotent and later audio is refused", async () => {
  const { audioSession } = recorder();
  audioSession.record("mic", ramp(10), mono(0));
  const finishing = audioSession.finish();
  expect(audioSession.finish()).toBe(finishing);
  await finishing;
  expect(audioSession.record("mic", ramp(10), mono(10))).toBe(false);
});
