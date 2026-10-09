import { afterEach, expect, test, vi } from "vitest";
import { AudioSegment } from "./segment";
import { SegmentExporter } from "./exporter";
import { TracePublisher } from "./publisher";
class TestAttachment {
  reference: { key: string; filename: string; content_type: string };
  constructor(options: { filename: string; contentType: string }) {
    this.reference = {
      key: "attachment",
      filename: options.filename,
      content_type: options.contentType,
    };
  }
  async upload(): Promise<{
    upload_status: "done" | "error";
    error_message?: string;
  }> {
    return { upload_status: "done" };
  }
}
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const span = { spanId: "root", log: vi.fn() };
  const turn = { log: vi.fn() },
    speaking = { log: vi.fn() };
  const segments: AudioSegment[] = [];
  const flush = vi.fn(async () => {});
  const intervals = [
    {
      recording_span_id: "root",
      recording_id: "call",
      channel_index: 1,
      start_offset_ms: 100,
      end_offset_ms: 140,
    },
  ];
  const publisher = new TracePublisher(
    span,
    flush,
    () => ({
      segments,
      origin: 1234,
      basis: "test",
      source: (channel) => ({ channel_index: channel }),
      closed: false,
    }),
    () => [
      { span: turn, intervals, alias: true },
      { span: speaking, intervals },
    ],
  );
  const executions = new Map<AudioSegment, SegmentExporter>();
  const exporter = {
    publishRecordings: () => publisher.publishRecordings(),
    publishSelections: () => publisher.publishSelections(),
    publish: async (segment: AudioSegment) => {
      await executions.get(segment)!.export(segment, () => {});
      await publisher.publish(segment);
    },
  };
  function encode(error?: string, bytes = 16) {
    const start = 100 + segments.length * 20;
    const segment = new AudioSegment(
      `call-${segments.length}`,
      start,
      start + 20,
      [
        {
          pcm: new Int16Array(480),
          at: 0,
          rate: 24000,
          channels: 1,
          channel: 1,
        },
      ],
    );
    segments.push(segment);
    publisher.publishRecordings();
    executions.set(
      segment,
      new SegmentExporter(
        async () => {
          if (error) {
            throw new Error(error);
          }
          return {
            bytes: new Uint8Array(bytes),
            durationMs: 20,
            sampleRate: 24000,
            mimeType: "audio/wav",
          };
        },
        (options) => new TestAttachment(options),
      ),
    );
    return segment;
  }
  const manifests = () =>
    span.log.mock.calls.flatMap(
      ([row]) => row.metadata?.["audio.recordings"] ?? [],
    );
  return { span, turn, speaking, exporter, encode, manifests };
}

test.each([16, 17 * 1024 * 1024])(
  "%i encoded bytes remain pending until ordinary attachment upload succeeds",
  async (bytes) => {
    let complete!: (status: { upload_status: "done" }) => void;
    const upload = vi
      .spyOn(TestAttachment.prototype, "upload")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
    const f = fixture(),
      segment = f.encode(undefined, bytes);
    const publication = f.exporter.publish(segment);
    try {
      f.exporter.publishRecordings();
      f.exporter.publishSelections();
      expect(f.manifests().every((m) => m.state === "pending")).toBe(true);
      expect(f.span.log.mock.calls.some(([row]) => row.input?.audio)).toBe(
        false,
      );
      for (const owner of [f.turn, f.speaking]) {
        expect(
          owner.log.mock.calls.flatMap(
            ([row]) => row.metadata?.["audio.selections"] ?? [],
          ),
        ).toEqual([]);
      }
      await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
      complete({ upload_status: "done" });
      await publication;
      expect(f.manifests().at(-1)).toMatchObject({
        state: "ready",
        attachment: { span_id: "root", ref: "/input/audio/call-0" },
      });
      expect(f.manifests()[0].state).toBe("pending");
      for (const owner of [f.turn, f.speaking]) {
        expect(
          owner.log.mock.calls.at(-1)![0].metadata["audio.selections"],
        ).toMatchObject([
          { recording_id: "call-0", start_offset_ms: 0, end_offset_ms: 20 },
        ]);
      }
      const reference = f.span.log.mock.calls.find(
        ([row]) => row.input?.audio,
      )![0].input.audio[segment.id];
      expect(reference).toMatchObject({
        key: expect.any(String),
        filename: "call-0.wav",
        content_type: "audio/wav",
      });
      expect(reference).not.toBeInstanceOf(TestAttachment);
      const rows = f.span.log.mock.calls.length;
      f.exporter.publishRecordings();
      f.exporter.publishSelections();
      expect(f.span.log.mock.calls).toHaveLength(rows);
    } finally {
      complete?.({ upload_status: "done" });
      await publication.catch(() => {});
    }
  },
);

test.each(["status", "rejection"])(
  "upload %s failure never publishes ready and preserves earlier audio",
  async (mode) => {
    const upload = vi
      .spyOn(TestAttachment.prototype, "upload")
      .mockResolvedValueOnce({ upload_status: "done" });
    const f = fixture();
    await f.exporter.publish(f.encode());
    if (mode === "status") {
      upload.mockResolvedValue({
        upload_status: "error",
        error_message: "upload unavailable",
      });
    } else {
      upload.mockRejectedValue(new Error("upload unavailable"));
    }
    await f.exporter.publish(f.encode());
    expect(
      f
        .manifests()
        .filter((m) => m.id === "call-1")
        .map((m) => m.state),
    ).not.toContain("ready");
    expect(f.manifests().at(-1)).not.toHaveProperty("attachment");
    expect(
      f.span.log.mock.calls.flatMap(([row]) =>
        Object.keys(row.input?.audio ?? {}),
      ),
    ).toEqual(["call-0"]);
    expect(f.manifests().at(-1)).toMatchObject({
      id: "call-1",
      state: "omitted",
      reason: "recording_export_failed",
    });
    expect(
      f
        .manifests()
        .filter((m) => m.id === "call-0")
        .at(-1).state,
    ).toBe("ready");
    for (const owner of [f.turn, f.speaking]) {
      expect(
        owner.log.mock.calls.at(-1)![0].metadata["audio.selections"],
      ).toMatchObject([{ recording_id: "call-0" }]);
    }
  },
);

test("encoding failure publishes an omission without uploading or selecting audio", async () => {
  const upload = vi.spyOn(TestAttachment.prototype, "upload");
  const f = fixture(),
    segment = f.encode("encoding_failed");
  await f.exporter.publish(segment);
  expect(upload).not.toHaveBeenCalled();
  expect(f.manifests().map((m) => m.state)).toEqual(["pending", "omitted"]);
  expect(f.manifests().at(-1)).toMatchObject({ reason: "encoding_failed" });
  expect(f.span.log.mock.calls.some(([row]) => row.input?.audio)).toBe(false);
  expect(f.turn.log.mock.calls.at(-1)![0].metadata["audio.selections"]).toEqual(
    [],
  );
});

test.each([false, true])(
  "encoding failure=%s releases PCM only after encoding settles",
  async (failed) => {
    let finish!: () => void;
    const encoding = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pcm = new Int16Array(480);
    const segment = new AudioSegment("call-0", 0, 20, [
      { pcm, at: 0, rate: 24000, channels: 1, channel: 0 },
    ]);
    const release = vi.fn();
    const upload = vi.fn(async () => {
      expect(release).toHaveBeenCalledExactlyOnceWith(pcm);
      expect(segment.state).toBe("pending");
      return { upload_status: "done" };
    });
    const exporter = new SegmentExporter(
      async () => {
        await encoding;
        if (failed) {
          throw new Error("encoding_failed");
        }
        return {
          bytes: new Uint8Array(16),
          durationMs: 20,
          sampleRate: 24000,
          mimeType: "audio/wav",
        };
      },
      () => ({ reference: "uploaded", upload }),
    );
    const job = exporter.export(segment, release);
    try {
      expect(release).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(segment.state).toBe("pending");
    } finally {
      finish();
      await job;
    }
    expect(release).toHaveBeenCalledExactlyOnceWith(pcm);
    expect(upload).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(segment.state).toBe(failed ? "omitted" : "ready");
  },
);
