/** Structural boundary for the optional recording extension; core builds without it. */
export interface RecordingOptions {
  segmentDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxBufferBytes?: number;
  flushFraction?: number;
}
export interface Packet {
  pcm: Int16Array;
  rate: number;
  channels: number;
  channel: number;
  at: number;
}
export interface Selection {
  recording_span_id: string;
  recording_id: string;
  start_offset_ms: number;
  end_offset_ms: number;
  channel_index: number;
}
type RecordingSpan = {
  spanId: string;
  log(event: { input?: unknown; metadata?: Record<string, unknown> }): void;
};
export interface Recording {
  recorder: {
    readonly reason?: string;
    readonly formats: ReadonlyMap<
      number,
      ReadonlyMap<string, { sample_rate_hz: number; channel_count: number }>
    >;
    stop(reason: string): void;
    copy(pcm: Int16Array): Int16Array | undefined;
    release(pcm: Int16Array): void;
    append(packet: Packet): boolean;
    record(packet: Packet): boolean;
    advance(watermark: number): void;
    drain(): Promise<void>;
    finish(): Promise<void>;
  };
  timeline: {
    CALL_SAMPLE_RATE: number;
    msToSamples(milliseconds: number, sampleRate?: number): number;
    samplesToMs(samples: number, sampleRate?: number): number;
    pcmBytesToMs(bytes: number, sampleRate: number, channels: number): number;
  };
  publishManifest(): void;
  publishSelections(): void;
}
export interface AudioExtension {
  createRecording(config: {
    options?: RecordingOptions;
    audioFormat?: "ogg" | "wav";
    encoder?: { module: string };
    span: RecordingSpan;
    flush(): Promise<void>;
    snapshot(): {
      origin: number;
      basis: string;
      source(channel: number): Record<string, unknown>;
      closed: boolean;
      metadata?: Record<string, unknown>;
    };
    targets(): Iterable<{
      span: Pick<RecordingSpan, "log">;
      intervals: Selection[];
      alias?: boolean;
      metadata?: Record<string, unknown>;
    }>;
    createAttachment(options: {
      data: Uint8Array;
      filename: string;
      contentType: string;
    }): {
      upload(): Promise<{ upload_status: string; error_message?: string }>;
      reference: unknown;
    };
  }): Recording;
}
