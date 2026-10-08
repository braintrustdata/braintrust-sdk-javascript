export type Packet = {
  pcm: Int16Array;
  rate: number;
  channels: number;
  channel: number;
  at: number;
};
export type EncodedAudio = {
  bytes: Uint8Array;
  durationMs: number;
  mimeType: string;
  sampleRate: number;
};
export type Segment = Readonly<{
  id: string;
  start: number;
  end: number;
  state: "pending" | "ready" | "omitted";
  reason?: string;
  mimeType?: string;
  sampleRate?: number;
  durationMs?: number;
  channels: readonly number[];
}>;

type AudioFormat = Omit<EncodedAudio, "bytes">;
type SegmentEvent =
  | { type: "encode" }
  | { type: "encoded"; format: AudioFormat }
  | { type: "ready"; reference: unknown }
  | { type: "omitted"; reason: string };
type SegmentState =
  | { phase: "queued"; packets: Packet[] }
  | { phase: "encoding" }
  | { phase: "uploading"; format: AudioFormat }
  | { phase: "ready"; format: AudioFormat; reference: unknown }
  | { phase: "omitted"; reason: string };

/** Owns segment transitions and its descriptor; the exporter owns encoded bytes. */
export class AudioSegment implements Segment {
  private current: SegmentState;
  readonly channels: readonly number[];

  constructor(
    readonly id: string,
    readonly start: number,
    readonly end: number,
    packets: Packet[],
  ) {
    this.current = { phase: "queued", packets };
    this.channels = [...new Set(packets.map((packet) => packet.channel))];
  }

  get state(): Segment["state"] {
    const { phase } = this.current;
    return phase === "ready" || phase === "omitted" ? phase : "pending";
  }
  get reason() {
    return this.current.phase === "omitted" ? this.current.reason : undefined;
  }
  private get format() {
    return "format" in this.current ? this.current.format : undefined;
  }
  get mimeType() {
    return this.format?.mimeType;
  }
  get sampleRate() {
    return this.format?.sampleRate;
  }
  get durationMs() {
    return this.format?.durationMs;
  }
  get attachmentReference() {
    return this.current.phase === "ready" ? this.current.reference : undefined;
  }

  dispatch(event: { type: "encode" }): Packet[];
  dispatch(event: Exclude<SegmentEvent, { type: "encode" }>): void;
  dispatch(event: SegmentEvent): Packet[] | void {
    const state = this.current;
    switch (event.type) {
      case "encode":
        if (state.phase === "queued") {
          this.current = { phase: "encoding" };
          return state.packets;
        }
        break;
      case "encoded":
        if (state.phase === "encoding") {
          const { durationMs, mimeType, sampleRate } = event.format;
          this.current = {
            phase: "uploading",
            format: { durationMs, mimeType, sampleRate },
          };
          return;
        }
        break;
      case "ready":
        if (state.phase === "uploading") {
          this.current = {
            phase: "ready",
            format: state.format,
            reference: event.reference,
          };
          return;
        }
        break;
      case "omitted":
        if (state.phase !== "ready" && state.phase !== "omitted") {
          this.current = { phase: "omitted", reason: event.reason };
          return;
        }
    }
    throw new Error(
      `Invalid audio segment transition: ${state.phase} -> ${event.type}`,
    );
  }
}
