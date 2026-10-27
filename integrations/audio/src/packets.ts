/**
 * Encoded audio passed from an encoder to a container, such as `opus()` to
 * `ogg()`. Sample counts use the codec clock (`meta.sampleRate`).
 */
export interface EncodedPackets {
  /** Codec name, such as `"opus"`. */
  readonly codec: string;
  /** Codec setup data a container stores ahead of the packets, such as OpusHead. */
  readonly headers: readonly Uint8Array[];
  readonly packets: readonly EncodedPacket[];
  /** Leading decoded samples to discard: the encoder delay (Ogg pre-skip). */
  readonly delay: number;
  /** Trailing decoded samples to discard after the last packet. */
  readonly padding: number;
}

export interface EncodedPacket {
  readonly data: Uint8Array;
  /** Decoded samples per channel in this packet. */
  readonly samples: number;
}
