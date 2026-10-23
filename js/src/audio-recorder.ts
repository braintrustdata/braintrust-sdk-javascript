import { PcmBuffer, pcmBytesToMs } from "./pcm-buffer";

/**
 * Describes what a segment is and where it sits on the recording timeline, in
 * terms any audio format shares.
 */
export interface AudioSegmentMeta {
  /** Zero-based position of this segment within its recording. */
  readonly index: number;
  /** Segment start on the recording timeline. */
  readonly startOffsetMs: number;
  /** Playable duration of the segment. */
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  /** Sources heard in this segment and the file channel each occupies. */
  readonly sources: readonly AudioSource[];
  /** Content type of the segment bytes, such as `audio/pcm`. */
  readonly mimeType: string;
  /** Sample or codec encoding, such as `s16le`. */
  readonly encoding: string;
}

/** A recorder source key, as given by the integration, on one file channel. */
type AudioSource = { readonly channel: number; readonly name: string };

type AudioRecorderOptions = {
  sampleRate: number;
  /** Source keys, one per output channel in order. */
  sources: readonly string[];
  /** Target size of each segment. */
  segmentBytes: number;
  /** Bound on buffered and reserved audio; one in-flight segment is extra. */
  maxBufferBytes?: number;
  maxDurationMs?: number;
  /** Receives each segment; the recorder waits for it to settle. */
  onFlush(segment: Uint8Array, meta: AudioSegmentMeta): void | Promise<void>;
  /** Receives the original metadata of a segment that failed, and the stop reason. */
  onError(meta: AudioSegmentMeta, reason: string, error: unknown): void;
};

/**
 * Assembles PCM on a channel timeline, cuts bounded segments behind a confirmed
 * offset, and passes them to `onFlush`, one at a time.
 */
export class AudioRecorder {
  private buffer: PcmBuffer;
  private confirmedThroughMs = 0;
  private reservedBytes = 0;
  private index = 0;
  private job?: Promise<void>;
  private finishing?: Promise<void>;
  private stopReason?: string;
  private isClosed = false;

  constructor(private options: AudioRecorderOptions) {
    const maxBufferBytes =
      options.maxBufferBytes ??
      Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(32 * 1024 * 1024, 2 * options.segmentBytes),
      );
    if (maxBufferBytes < options.segmentBytes)
      throw new Error("invalid_buffer_limit");
    this.buffer = new PcmBuffer({
      sampleRate: options.sampleRate,
      channels: options.sources.length,
      maxBufferBytes,
    });
  }

  get reason(): string | undefined {
    return this.stopReason;
  }
  get closed(): boolean {
    return this.isClosed;
  }
  /** Whether new audio is accepted. */
  get active(): boolean {
    return !this.isClosed && !this.stopReason;
  }
  /** Stops accepting audio. Accepted audio still flushes on finish. */
  stop(reason: string): void {
    this.stopReason ??= reason;
  }

  /**
   * Writes positioned PCM for a source, stopping on any limit or invalid audio.
   * `channelCount` is the number of interleaved channels in `samples`; they are
   * downmixed onto the source's channel.
   */
  record(
    source: string,
    samples: Int16Array,
    format: { sampleRate: number; channelCount: number; offsetMs: number },
  ): boolean {
    if (!this.active) return false;
    const channel = this.options.sources.indexOf(source);
    if (channel < 0) {
      this.stop("unknown_audio_source");
      return false;
    }
    const end =
      format.offsetMs +
      pcmBytesToMs(samples.byteLength, format.sampleRate, format.channelCount);
    if (end > (this.options.maxDurationMs ?? Infinity)) {
      this.stop("duration_limit");
      return false;
    }
    const bytes =
      Math.round(
        ((samples.length / format.channelCount) * this.buffer.sampleRate) /
          format.sampleRate,
      ) * 2;
    if (!this.fits(bytes)) return false;
    try {
      this.buffer.write(samples, {
        sampleRate: format.sampleRate,
        channels: format.channelCount,
        channel,
        offsetMs: format.offsetMs,
      });
    } catch (error) {
      this.stop(error instanceof Error ? error.message : "capture_failed");
      return false;
    }
    return true;
  }

  /** Reserves budget for audio held before it can be recorded. */
  reserve(bytes: number): boolean {
    if (!this.active || !this.fits(bytes)) return false;
    this.reservedBytes += bytes;
    return true;
  }
  release(bytes: number): void {
    this.reservedBytes -= bytes;
  }

  /** No audio will be recorded before `throughMs`, so earlier audio may flush. */
  advance(throughMs: number): void {
    this.confirmedThroughMs = Math.max(this.confirmedThroughMs, throughMs);
    this.pump();
  }

  /** Stops capture, flushes the remainder, and resolves once every flush settles. */
  finish(): Promise<void> {
    return (this.finishing ??= (async () => {
      this.isClosed = true;
      this.pump();
      while (this.job) await this.job;
    })());
  }

  private fits(bytes: number): boolean {
    if (
      this.buffer.bufferedByteLength + this.reservedBytes + bytes <=
      this.buffer.maxBufferBytes
    )
      return true;
    this.stop("capture_byte_limit");
    return false;
  }

  private pump(): void {
    if (
      this.job ||
      !this.buffer.bufferedByteLength ||
      (this.stopReason && !this.isClosed)
    )
      return;
    let cut: ReturnType<PcmBuffer["flush"]>;
    try {
      cut = this.buffer.flush({
        maxBytes: this.options.segmentBytes,
        endOffsetMs: this.isClosed
          ? undefined
          : Math.min(this.confirmedThroughMs, this.buffer.endOffsetMs),
        partial: this.isClosed,
      });
    } catch (error) {
      this.stop(
        error instanceof Error ? error.message : "recording_export_failed",
      );
      return;
    }
    if (!cut) return;
    const meta: AudioSegmentMeta = {
      index: this.index++,
      startOffsetMs: cut.startOffsetMs,
      durationMs: cut.endOffsetMs - cut.startOffsetMs,
      sampleRate: this.buffer.sampleRate,
      channelCount: this.buffer.channels,
      sources: cut.channels.map((channel) => ({
        channel,
        name: this.options.sources[channel],
      })),
      mimeType: "audio/pcm",
      encoding: "s16le",
    };
    this.job = this.process(cut.data, meta).finally(() => {
      this.job = undefined;
      this.pump();
    });
  }

  private async process(segment: Uint8Array, meta: AudioSegmentMeta) {
    try {
      await this.options.onFlush(segment, meta);
    } catch (error) {
      this.fail("recording_export_failed", error, meta);
    }
  }

  private fail(reason: string, error: unknown, meta: AudioSegmentMeta) {
    this.stop(reason);
    try {
      this.options.onError(meta, reason, error);
    } catch {
      // Reporting must not break draining.
    }
  }
}
