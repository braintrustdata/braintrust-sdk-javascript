import { msToSamples, samplesToMs, pcmBytesToMs } from "./timeline";
import { AudioSegment, type Packet } from "./segment";
export type { Packet } from "./segment";
import { PcmBuffers } from "./buffers";
import type { SegmentExporter } from "./exporter";
export type RecordingOptions = {
  segmentDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxBufferBytes?: number;
  flushFraction?: number;
};
/** Framework-independent recorder. The adapter supplies a safe, monotonic cut watermark. */
export class Recorder {
  readonly options: Readonly<Required<RecordingOptions>>;
  private packets: Packet[] = [];
  readonly segments: AudioSegment[] = [];
  readonly formats = new Map<
    number,
    Map<string, { sample_rate_hz: number; channel_count: number }>
  >();
  reason?: string;
  private buffers: PcmBuffers;
  get retainedBytes() {
    return this.buffers.bytes;
  }
  private job?: Promise<void>;
  private segmentStartMs = 0;
  private recordedEndMs = 0;
  private earliestPacketMs = Infinity;
  private closed = false;
  private finishing?: Promise<void>;
  private confirmedThroughMs = 0;
  constructor(
    options: RecordingOptions,
    private exporter: SegmentExporter,
    private publish: (segment: AudioSegment) => Promise<void>,
    private pending: (segment: AudioSegment) => void = () => {},
  ) {
    this.options = Object.freeze({
      segmentDurationSeconds: options.segmentDurationSeconds ?? 60,
      maxDurationSeconds: options.maxDurationSeconds ?? 1800,
      maxBufferBytes: options.maxBufferBytes ?? 32 * 1024 * 1024,
      flushFraction: options.flushFraction ?? 0.5,
    });
    validateOptions(this.options);
    this.buffers = new PcmBuffers(this.options.maxBufferBytes);
  }

  stop(reason: string) {
    this.reason ??= reason;
  }
  copy(pcm: Int16Array): Int16Array | undefined {
    if (this.closed || this.reason) {
      return;
    }
    try {
      return this.buffers.copy(pcm);
    } catch (error) {
      this.stop(error instanceof Error ? error.message : "capture_failed");
      return;
    }
  }
  /** Discard staged audio; admitted audio belongs to the recorder/worker. */
  release(pcm: Int16Array) {
    this.buffers.discard(pcm);
  }
  append(packet: Packet): boolean {
    const duration = pcmBytesToMs(
      packet.pcm.byteLength,
      packet.rate,
      packet.channels,
    );
    const reason = this.validatePacket(packet, duration);
    if (reason) {
      this.stop(reason);
    }
    if (this.closed || this.reason) {
      this.release(packet.pcm);
      return false;
    }
    if (!this.buffers.admit(packet.pcm)) {
      this.stop("invalid_pcm_ownership");
      return false;
    }
    const formats = this.formats.get(packet.channel) ?? new Map();
    formats.set(`${packet.rate}:${packet.channels}`, {
      sample_rate_hz: packet.rate,
      channel_count: packet.channels,
    });
    this.formats.set(packet.channel, formats);
    this.packets.push(packet);
    this.earliestPacketMs = Math.min(this.earliestPacketMs, packet.at);
    this.recordedEndMs = Math.max(this.recordedEndMs, packet.at + duration);
    return true;
  }
  private validatePacket(
    packet: Packet,
    durationMs: number,
  ): string | undefined {
    if (!isSupportedPacket(packet)) {
      return "unsupported_audio_format";
    }
    if (packet.at < this.segmentStartMs - samplesToMs(1)) {
      return "capture_clock_discontinuity";
    }
    if (packet.at + durationMs > this.options.maxDurationSeconds * 1000) {
      return "duration_limit";
    }
    if (this.packets.length >= 100000) {
      return "packet_limit";
    }
    return undefined;
  }

  record(packet: Packet): boolean {
    const pcm = this.copy(packet.pcm);
    return pcm ? this.append({ ...packet, pcm }) : false;
  }
  advance(watermark: number) {
    if (
      this.closed ||
      this.reason ||
      !Number.isFinite(watermark) ||
      watermark <= this.segmentStartMs
    ) {
      return;
    }
    this.confirmedThroughMs = Math.max(this.confirmedThroughMs, watermark);
    this.pump();
  }
  // One job per recorder. Completion resumes eligible work without requiring
  // another frame or blocking the application. Source limits bound the backlog.
  private pump() {
    if (this.job || !this.packets.length || (this.reason && !this.closed)) {
      return;
    }
    const limit = this.closed
      ? this.recordedEndMs
      : Math.min(this.confirmedThroughMs, this.recordedEndMs);
    const duration = this.options.segmentDurationSeconds * 1000;
    if (this.earliestPacketMs >= this.segmentStartMs + duration) {
      this.segmentStartMs +=
        Math.floor(
          (Math.min(this.earliestPacketMs, limit) - this.segmentStartMs) /
            duration,
        ) * duration;
    }
    const cut = this.segmentStartMs + duration;
    if (limit >= cut) {
      this.rotate(cut);
    } else if (
      this.closed ||
      this.retainedBytes >=
        this.options.maxBufferBytes * this.options.flushFraction
    ) {
      this.rotate(limit);
    }
  }
  private rotate(cut: number) {
    if (!this.packets.length || cut <= this.segmentStartMs) {
      return;
    }
    const { before, later } = this.splitPackets(cut);
    if (!before.length) {
      return;
    }
    const segment = new AudioSegment(
      `call-${String(this.segments.length).padStart(4, "0")}`,
      this.segmentStartMs,
      cut,
      before,
    );
    this.packets = later;
    this.earliestPacketMs = later.reduce((v, p) => Math.min(v, p.at), Infinity);
    this.segmentStartMs = cut;
    this.segments.push(segment);
    try {
      this.pending(segment);
    } catch {
      // Pending telemetry is best effort; upload publication sends the full recording descriptors.
    }
    this.job = this.exportSegment(segment).finally(() => {
      this.job = undefined;
      this.pump();
    });
    // Capture never awaits this task; drain()/finish() observe completion.
    void this.job.catch(() => {});
  }

  private async exportSegment(segment: AudioSegment): Promise<void> {
    await this.exporter.export(segment, (pcm) => this.buffers.release(pcm));
    if (segment.state === "omitted") {
      this.stop(segment.reason!);
    }
    // Trace publication cannot change the outcome of an audio export.
    await this.publish(segment).catch(() => {});
  }

  /** Partition at a sample boundary; only a crossing packet requires copies. */
  private splitPackets(cutMs: number): { before: Packet[]; later: Packet[] } {
    const before: Packet[] = [],
      later: Packet[] = [];
    for (const packet of this.packets) {
      const count = Math.min(
        packet.pcm.length,
        Math.max(
          0,
          Math.round(msToSamples(cutMs - packet.at, packet.rate)) *
            packet.channels,
        ),
      );
      if (!count) {
        later.push(packet);
      } else if (count === packet.pcm.length) {
        before.push({ ...packet, at: packet.at - this.segmentStartMs });
      } else {
        // Splitting preserves the original reservation: the two new allocations
        // have the same total source size and the old allocation is discarded.
        const [head, tail] = this.buffers.split(packet.pcm, count);
        before.push({
          ...packet,
          pcm: head,
          at: packet.at - this.segmentStartMs,
        });
        later.push({
          ...packet,
          pcm: tail,
          at: packet.at + samplesToMs(count / packet.channels, packet.rate),
        });
      }
    }
    return { before, later };
  }

  async drain() {
    while (this.job) {
      await this.job;
    }
  }
  finish(): Promise<void> {
    if (!this.finishing) {
      this.finishing = this.finishOnce();
    }
    return this.finishing;
  }
  private async finishOnce() {
    this.closed = true;
    this.pump();
    await this.drain();
    // Unsubmitted copies (e.g. cancelled output) have no worker owner now.
    this.buffers.close();
    this.packets = [];
  }
}

function validateOptions(options: Required<RecordingOptions>): void {
  const {
    segmentDurationSeconds,
    maxDurationSeconds,
    maxBufferBytes,
    flushFraction,
  } = options;
  const positiveLimits = [
    segmentDurationSeconds,
    maxDurationSeconds,
    maxBufferBytes,
  ];
  if (
    !positiveLimits.every((value) => Number.isFinite(value) && value > 0) ||
    !Number.isInteger(maxBufferBytes) ||
    !(flushFraction > 0 && flushFraction < 1)
  ) {
    throw new Error("Invalid recording limits");
  }
}

function isSupportedPacket(packet: Packet): boolean {
  return (
    Number.isFinite(packet.at) &&
    packet.at >= 0 &&
    [0, 1].includes(packet.channel) &&
    [1, 2].includes(packet.channels) &&
    Number.isFinite(packet.rate) &&
    packet.rate >= 8000 &&
    packet.rate <= 96000 &&
    packet.pcm.length % packet.channels === 0
  );
}
