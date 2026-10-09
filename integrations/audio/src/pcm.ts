import { msToSamples, samplesToMs, CALL_SAMPLE_RATE } from "./timeline";
import type { Packet } from "./recorder";
/** Bounded 24kHz stereo WAV assembly, entirely outside the voice event loop. */
export function encodeCall(
  packets: Packet[],
  durationMs?: number,
): {
  bytes: Uint8Array;
  durationMs: number;
} {
  const rate = CALL_SAMPLE_RATE;
  const samples =
    durationMs === undefined
      ? Math.ceil(
          packets.reduce(
            (end, p) =>
              Math.max(
                end,
                msToSamples(p.at, rate) +
                  (p.pcm.length / p.channels / p.rate) * rate,
              ),
            0,
          ),
        )
      : Math.round(msToSamples(durationMs, rate));
  if (!Number.isSafeInteger(samples) || samples <= 0 || samples > 1800 * rate) {
    throw new Error("invalid_duration");
  }
  const bytes = new Uint8Array(44 + samples * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      bytes[offset + i] = value.charCodeAt(i);
    }
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 4, true);
  let offset = 44;
  for (const chunk of pcmChunks(packets, samplesToMs(samples, rate), rate)) {
    for (const value of chunk) {
      view.setInt16(offset, value, true);
      offset += 2;
    }
  }
  return { bytes, durationMs: samplesToMs(samples, rate) };
}

/** Render bounded stereo blocks. Resampling positions stay relative to each
 * source packet, so a block boundary never resets interpolation phase.
 * Blocks borrow a reusable buffer, valid until the iterator advances. */
export function* pcmChunks(
  packets: Packet[],
  durationMs: number,
  rate = CALL_SAMPLE_RATE,
): Generator<Int16Array> {
  const samples = Math.round(msToSamples(durationMs, rate));
  if (
    ![24000, 48000].includes(rate) ||
    !Number.isSafeInteger(samples) ||
    samples <= 0 ||
    samples > 1800 * rate
  ) {
    throw new Error("invalid_duration");
  }
  const pending = packets
    .map((packet, index) => {
      if (
        ![0, 1].includes(packet.channel) ||
        ![1, 2].includes(packet.channels) ||
        !Number.isFinite(packet.rate) ||
        packet.rate < 8000 ||
        packet.rate > 96000 ||
        !Number.isFinite(packet.at) ||
        packet.at < 0
      ) {
        throw new Error("invalid_packet");
      }
      const start = Math.round(msToSamples(packet.at, rate));
      return {
        packet,
        index,
        start,
        end:
          start +
          Math.round(
            (packet.pcm.length / packet.channels / packet.rate) * rate,
          ),
      };
    })
    .sort((a, b) => a.start - b.start || a.index - b.index);
  let cursor = 0;
  let active: typeof pending = [];
  const buffer = new Int16Array((rate / 10) * 2);
  for (let start = 0; start < samples; start += rate / 10) {
    const end = Math.min(samples, start + rate / 10);
    active = active.filter((p) => p.end > start);
    while (cursor < pending.length && pending[cursor].start < end) {
      active.push(pending[cursor++]);
    }
    // Overlapping packets retain the same last-writer behavior as WAV assembly.
    active.sort((a, b) => a.index - b.index);
    const chunk = buffer.subarray(0, (end - start) * 2);
    chunk.fill(0);
    for (const { packet: p, start: packetStart, end: packetEnd } of active) {
      for (
        let i = Math.max(start, packetStart);
        i < Math.min(end, packetEnd);
        i++
      ) {
        const position = ((i - packetStart) * p.rate) / rate,
          lo = Math.floor(position),
          alpha = position - lo;
        let value = 0;
        for (let channel = 0; channel < p.channels; channel++) {
          const a =
            p.pcm[Math.min(lo * p.channels + channel, p.pcm.length - 1)] ?? 0;
          const b =
            p.pcm[
              Math.min((lo + 1) * p.channels + channel, p.pcm.length - 1)
            ] ?? a;
          value += a + (b - a) * alpha;
        }
        chunk[(i - start) * 2 + p.channel] = Math.max(
          -32768,
          Math.min(32767, Math.round(value / p.channels)),
        );
      }
    }
    yield chunk;
  }
}
