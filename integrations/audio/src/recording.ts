import { Recorder, type RecordingOptions } from "./recorder";
import {
  TracePublisher,
  type RecordingSpan,
  type RecordingContext,
  type TurnSelection,
} from "./publisher";
import { SegmentExporter, type CreateAttachment } from "./exporter";
import { createEncoder } from "./worker";
import { oggOpus } from "./codec";
import type { Packet } from "./segment";

export interface RecordingConfig {
  options?: RecordingOptions;
  audioFormat?: "ogg" | "wav";
  encoder?: { module: string };
  span: RecordingSpan;
  flush: () => Promise<void>;
  snapshot: () => Omit<RecordingContext, "closed">;
  /** Latest turn spans and call-relative audio intervals; used to publish audio.selections. */
  turnSelections: () => Iterable<TurnSelection>;
  createAttachment: CreateAttachment;
}
/** One recording session. Pipeline components remain private to the package. */
class Recording {
  private readonly recorder: Recorder;
  private readonly publisher: TracePublisher;
  private closed = false;
  private finishing?: Promise<void>;

  constructor(config: RecordingConfig) {
    this.recorder = new Recorder(
      config.options ?? {},
      new SegmentExporter(
        createEncoder(
          config.encoder ??
            (config.audioFormat === "wav" ? undefined : oggOpus()),
        ),
        config.createAttachment,
      ),
      (segment) => this.publisher.publish(segment),
      () => this.publisher.publishRecordings(),
    );
    this.publisher = new TracePublisher(
      config.span,
      config.flush,
      () => ({
        ...config.snapshot(),
        closed: this.closed,
        segments: this.recorder.segments,
        reason: this.recorder.reason,
      }),
      config.turnSelections,
    );
  }

  get reason() {
    return this.recorder.reason;
  }
  get formats(): ReadonlyMap<
    number,
    ReadonlyMap<string, { sample_rate_hz: number; channel_count: number }>
  > {
    return this.recorder.formats;
  }
  /** Copy a timestamped PCM frame into the recording. */
  record(packet: Packet): boolean {
    return this.recorder.record(packet);
  }
  /** Confirm that no more frames will arrive before this recording offset. */
  advance(confirmedThroughMs: number): void {
    this.recorder.advance(confirmedThroughMs);
  }
  stop(reason: string): void {
    this.recorder.stop(reason);
  }
  drain(): Promise<void> {
    return this.recorder.drain();
  }
  /** Finish the final segment and wait for encoding, uploads, and trace publication. */
  finish(): Promise<void> {
    if (!this.finishing) {
      this.closed = true;
      this.finishing = this.recorder
        .finish()
        .then(() => this.publisher.publish());
    }
    return this.finishing;
  }

  // Staged playback: copy now, then append only the audio actually played, or release it.
  copy(pcm: Int16Array): Int16Array | undefined {
    return this.recorder.copy(pcm);
  }
  append(packet: Packet): boolean {
    return this.recorder.append(packet);
  }
  release(pcm: Int16Array): void {
    this.recorder.release(pcm);
  }
  publishRecordings(): void {
    this.publisher.publishRecordings();
  }
  publishSelections(): void {
    this.publisher.publishSelections();
  }
}

/** Create a framework-independent recording session. */
export function createRecording(config: RecordingConfig) {
  return new Recording(config);
}
