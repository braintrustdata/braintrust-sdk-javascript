const MAX_CHUNKS = 100_000;

type Chunk = { samples: Int16Array; start: number; channel: number };

/**
 * Incremental signed 16-bit little-endian PCM on a shared sample clock.
 * write() copies, resamples, and downmixes a positioned source onto one
 * output channel; flush() consumes a prefix as interleaved bytes.
 */
export class PcmBuffer {
  private chunks: Chunk[] = [];
  private start = 0;
  private end = 0;
  private bytes = 0;
  readonly sampleRate: number;
  readonly channels: number;
  readonly maxBufferBytes: number;

  constructor(options: {
    sampleRate: number;
    channels: number;
    maxBufferBytes?: number;
  }) {
    if (
      !Number.isInteger(options.sampleRate) ||
      options.sampleRate <= 0 ||
      !Number.isInteger(options.channels) ||
      options.channels <= 0
    ) {
      throw new Error("unsupported_audio_format");
    }
    this.sampleRate = options.sampleRate;
    this.channels = options.channels;
    this.maxBufferBytes = options.maxBufferBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBufferBytes) || this.maxBufferBytes <= 0)
      throw new Error("invalid_buffer_limit");
  }

  get bufferedByteLength() {
    return this.bytes;
  }
  get endOffsetMs() {
    return samplesToMs(this.end, this.sampleRate);
  }

  /** Later writes win where sources overlap; flushed audio cannot change. */
  write(
    data: Int16Array,
    {
      sampleRate,
      channels,
      channel,
      offsetMs,
    }: {
      sampleRate: number;
      channels: number;
      channel: number;
      offsetMs: number;
    },
  ): this {
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isInteger(channels) ||
      channels <= 0 ||
      !Number.isInteger(channel) ||
      channel < 0 ||
      channel >= this.channels ||
      !Number.isFinite(offsetMs) ||
      offsetMs < 0
    )
      throw new Error("unsupported_audio_format");
    if (data.length % channels) throw new Error("incomplete_pcm_frame");
    const start = Math.round(msToSamples(offsetMs, this.sampleRate));
    if (start < this.start) throw new Error("capture_clock_discontinuity");
    const sourceFrames = data.length / channels;
    const frames = Math.round((sourceFrames * this.sampleRate) / sampleRate);
    if (this.bytes + frames * 2 > this.maxBufferBytes)
      throw new Error("capture_byte_limit");
    if (this.chunks.length >= MAX_CHUNKS) throw new Error("packet_limit");
    let samples: Int16Array;
    if (sampleRate === this.sampleRate && channels === 1)
      samples = data.slice();
    else {
      // Linear interpolation, averaging source channels into the target channel.
      samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        const position = (i * sampleRate) / this.sampleRate;
        const lo = Math.min(Math.floor(position), sourceFrames - 1);
        const hi = Math.min(lo + 1, sourceFrames - 1);
        const alpha = position - Math.floor(position);
        let value = 0;
        for (let c = 0; c < channels; c++) {
          const a = data[lo * channels + c];
          value += a + (data[hi * channels + c] - a) * alpha;
        }
        samples[i] = Math.round(value / channels);
      }
    }
    if (frames) this.chunks.push({ samples, start, channel });
    this.bytes += frames * 2;
    this.end = Math.max(this.end, start + frames);
    return this;
  }

  /**
   * Consume at most maxBytes through an optional confirmed offset; future
   * writes may continue. Waits for a full chunk unless partial is set. Cuts align
   * to complete sample frames (at least one), skipping wholly empty intervals.
   */
  flush(options: {
    maxBytes: number;
    endOffsetMs?: number;
    partial?: boolean;
  }):
    | {
        data: Uint8Array;
        startOffsetMs: number;
        endOffsetMs: number;
        /** Output channels that received samples. */
        channels: number[];
      }
    | undefined {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
      throw new Error("invalid_digest_byte_limit");
    let end =
      options.endOffsetMs === undefined
        ? this.end
        : Math.round(msToSamples(options.endOffsetMs, this.sampleRate));
    if (!Number.isSafeInteger(end) || end < this.start || end > this.end)
      throw new Error("invalid_digest_offset");
    const frames = Math.max(
      1,
      Math.floor(options.maxBytes / (this.channels * 2)),
    );
    const first = this.chunks.reduce((min, c) => Math.min(min, c.start), end);
    // Skip empty chunks without allocating silence or emitting attachments.
    this.start += Math.floor((first - this.start) / frames) * frames;
    const cut = this.start + frames;
    if (end < cut && !options.partial) return;
    end = Math.min(end, cut);
    const start = this.start;
    if (end === start) return;
    const included = this.chunks.filter((c) => c.start < end);
    if (!included.length) {
      this.start = end;
      return;
    }
    const size = (end - start) * this.channels * 2;
    if (size > this.maxBufferBytes) throw new Error("capture_byte_limit");
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    for (const chunk of included) {
      const count = Math.min(end - chunk.start, chunk.samples.length);
      for (let i = 0; i < count; i++)
        view.setInt16(
          ((chunk.start - start + i) * this.channels + chunk.channel) * 2,
          chunk.samples[i],
          true,
        );
    }
    const channels = [...new Set(included.map((c) => c.channel))].sort(
      (a, b) => a - b,
    );
    this.chunks = this.chunks.flatMap((chunk) => {
      if (chunk.start >= end) return [chunk];
      const consumed = Math.min(chunk.samples.length, end - chunk.start);
      this.bytes -= consumed * 2;
      // Copy the tail so it doesn't retain the already flushed prefix's allocation.
      return consumed === chunk.samples.length
        ? []
        : [{ ...chunk, start: end, samples: chunk.samples.slice(consumed) }];
    });
    this.start = end;
    return {
      data: bytes,
      startOffsetMs: samplesToMs(start, this.sampleRate),
      endOffsetMs: samplesToMs(end, this.sampleRate),
      channels,
    };
  }
}

export function msToSamples(milliseconds: number, sampleRate = 24000) {
  return milliseconds * (sampleRate / 1000);
}
export function samplesToMs(samples: number, sampleRate = 24000) {
  return samples / (sampleRate / 1000);
}
export function pcmBytesToMs(
  bytes: number,
  sampleRate: number,
  channels: number,
) {
  return samplesToMs(bytes / 2 / channels, sampleRate);
}
