export type RecordingSpan = {
  spanId: string;
  log: (event: { input?: unknown; metadata?: Record<string, unknown> }) => void;
};
import type { Segment } from "./segment";
import type { AudioSegment } from "./segment";
import {
  mergeSelections,
  segmentSelections,
  type Selection,
} from "./selections";

export type TurnSelection = {
  span: Pick<RecordingSpan, "log">;
  intervals: Selection[];
  alias?: boolean;
  metadata?: Record<string, unknown>;
};
export type RecordingContext = {
  origin: number;
  basis: string;
  source: (channel: number) => Record<string, unknown>;
  closed: boolean;
  metadata?: Record<string, unknown>;
};
type PublishedSegment = Pick<
  AudioSegment,
  "id" | "state" | "attachmentReference"
>;
type Snapshot = RecordingContext & {
  segments: readonly Segment[];
  reason?: string;
};
/** Publishes recording snapshots and uploaded attachment references. No framework types. */
export class TracePublisher {
  private publishedRecordings?: string;
  private publishedSelections = new WeakMap<object, string>();
  constructor(
    private span: RecordingSpan,
    private flush: () => Promise<void>,
    private snapshot: () => Snapshot,
    private turnSelections: () => Iterable<TurnSelection>,
  ) {}
  async publish(segment?: PublishedSegment) {
    // Retry telemetry once, independently of the completed export.
    try {
      await this.publishOnce(segment);
    } catch {
      await this.publishOnce(segment).catch(() => {});
    }
  }
  private async publishOnce(segment?: PublishedSegment) {
    try {
      // Retain only the reference so a logging failure can retry without uploading again.
      if (
        segment?.state === "ready" &&
        segment.attachmentReference !== undefined
      ) {
        this.span.log({
          input: { audio: { [segment.id]: segment.attachmentReference } },
        });
      }
      this.publishRecordings();
      this.publishSelections();
      await this.flush();
    } catch (error) {
      // A failed flush may not have delivered any queued updates. Retry snapshots
      // as well as the uploaded reference, without re-encoding or re-uploading.
      this.publishedRecordings = undefined;
      this.publishedSelections = new WeakMap();
      throw error;
    }
  }
  publishRecordings() {
    const snapshot = this.snapshot();
    const descriptors: Record<string, unknown>[] = snapshot.segments.map(
      (s) => ({
        id: s.id,
        recording_group_id: "call",
        state: s.state,
        ...(s.reason ? { reason: s.reason } : {}),
        ...(s.state === "ready"
          ? {
              attachment: {
                span_id: this.span.spanId,
                ref: `/input/audio/${s.id}`,
              },
              mime_type: s.mimeType,
              duration_ms: s.durationMs,
              channel_count: 2,
              sample_rate_hz: s.sampleRate,
            }
          : {}),
        sources: s.channels.map(snapshot.source),
        timeline: {
          origin_unix_ms: snapshot.origin,
          recording_start_offset_ms: s.start,
          basis: snapshot.basis,
        },
        ...(s.state === "omitted"
          ? {
              gaps: [
                {
                  start_offset_ms: s.start,
                  end_offset_ms: s.end,
                  reason: s.reason,
                },
              ],
            }
          : {}),
      }),
    );
    if (snapshot.reason) {
      descriptors.push({
        id: "call",
        recording_group_id: "call",
        state: "omitted",
        reason: snapshot.reason,
        truncated: true,
      });
    }
    if (!descriptors.length) {
      descriptors.push({
        id: "call",
        recording_group_id: "call",
        state: snapshot.closed ? "omitted" : "pending",
        ...(snapshot.closed ? { reason: "no_audio_observed" } : {}),
      });
    }
    // Compare the serialized wire value: callbacks can return freshly allocated or
    // mutated metadata. Identity/version checks would miss those changes.
    const signature = JSON.stringify({
      recordings: descriptors,
      metadata: snapshot.metadata,
    });
    if (this.publishedRecordings === signature) {
      return;
    }
    this.span.log({
      metadata: {
        "audio.recordings": descriptors,
        ...snapshot.metadata,
      },
    });
    this.publishedRecordings = signature;
  }
  publishSelections() {
    const { segments } = this.snapshot();
    for (const turn of this.turnSelections()) {
      const selections = segmentSelections(
        mergeSelections(turn.intervals),
        segments,
      );
      const metadata = {
        "audio.selections": selections,
        ...(turn.alias
          ? {
              "audio.selection": selections.length === 1 ? selections[0] : null,
            }
          : {}),
        ...turn.metadata,
      };
      const signature = JSON.stringify(metadata);
      if (this.publishedSelections.get(turn.span) === signature) {
        continue;
      }
      turn.span.log({ metadata });
      this.publishedSelections.set(turn.span, signature);
    }
  }
}
