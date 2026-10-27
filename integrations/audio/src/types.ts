/**
 * The SDK's internal audio middleware contract, which this package implements.
 * Keep in sync with `js/src/audio-middleware.ts`; the registry `version` gates
 * compatibility at runtime.
 */
export interface AudioSegmentMeta {
  readonly index: number;
  readonly startOffsetMs: number;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly sources: readonly {
    readonly channel: number;
    readonly name: string;
  }[];
  /** Content type of the segment bytes, such as `audio/pcm`. */
  readonly mimeType: string;
  /** Sample or codec encoding, such as `s16le`. */
  readonly encoding: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly state?: Readonly<Record<string, unknown>>;
}

type AudioResult = { segment: Uint8Array; meta: AudioSegmentMeta };

/** Transforms a segment, Rack/Koa style; `next` runs the rest of the stack. */
export type AudioMiddleware<In = Uint8Array, Down = In> = (
  segment: In,
  meta: AudioSegmentMeta,
  next: (segment: Down, meta: AudioSegmentMeta) => Promise<AudioResult>,
) => AudioResult | Promise<AudioResult>;
