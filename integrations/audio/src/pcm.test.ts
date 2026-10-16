import { expect, test } from "vitest";
import { encodeCall, pcmChunks } from "./pcm";

test("bounded rendering preserves resampling phase across chunks and pads the final timeline", () => {
  const source = Int16Array.from(
    { length: 12000 },
    (_, i) => (i % 97) * 100 - 4000,
  );
  for (const rate of [24000, 48000]) {
    const frames = Array.from(
      pcmChunks(
        [{ pcm: source, rate: 44100, channels: 1, channel: 1, at: 7.3 }],
        400,
        rate,
      ),
      (block) => block.slice(),
    );
    expect(Math.max(...frames.map((f) => f.length))).toBeLessThanOrEqual(
      (rate / 10) * 2,
    );
    const actual = Int16Array.from(frames.flatMap((f) => [...f]));
    expect(actual.length).toBe(rate * 0.4 * 2);
    const start = Math.round((7.3 * rate) / 1000),
      length = Math.round((source.length / 44100) * rate);
    for (let i = 0; i < actual.length / 2; i++) {
      const position = ((i - start) * 44100) / rate,
        lo = Math.floor(position),
        alpha = position - lo;
      const expected =
        i < start || i >= start + length
          ? 0
          : Math.round(
              source[Math.min(lo, source.length - 1)] * (1 - alpha) +
                source[Math.min(lo + 1, source.length - 1)] * alpha,
            );
      expect(actual[i * 2]).toBe(0);
      expect(actual[i * 2 + 1]).toBe(expected);
    }
  }
});

test("rendering preserves packet overwrite order, channel separation, silence and WAV samples", () => {
  const packets = [
    {
      pcm: new Int16Array(4800).fill(123),
      rate: 24000,
      channels: 1,
      channel: 0,
      at: 50,
    },
    {
      pcm: new Int16Array(4800).fill(456),
      rate: 24000,
      channels: 1,
      channel: 1,
      at: 0,
    },
    {
      pcm: new Int16Array(4800).fill(789),
      rate: 24000,
      channels: 1,
      channel: 0,
      at: 0,
    },
  ];
  const pcm = Int16Array.from(
    Array.from(pcmChunks(packets, 300), (block) => [...block]).flat(),
  );
  const wav = encodeCall(packets, 300),
    view = new DataView(wav.bytes.buffer);
  for (let i = 0; i < pcm.length / 2; i++) {
    expect(pcm[i * 2]).toBe(i < 4800 ? 789 : i < 6000 ? 123 : 0);
    expect(pcm[i * 2 + 1]).toBe(i < 4800 ? 456 : 0);
    expect(view.getInt16(44 + i * 4, true)).toBe(pcm[i * 2]);
    expect(view.getInt16(46 + i * 4, true)).toBe(pcm[i * 2 + 1]);
  }
});

// Exercise both upsampling and downsampling through the rendered WAV output.
test("mixed source rates retain channel values and duration", () => {
  const result = encodeCall([
    {
      pcm: new Int16Array(160).fill(1000),
      rate: 8000,
      channels: 1,
      channel: 0,
      at: 0,
    },
    {
      pcm: new Int16Array(960).fill(-1000),
      rate: 48000,
      channels: 1,
      channel: 1,
      at: 0,
    },
  ]);
  expect(result.durationMs).toBe(20);
  const view = new DataView(
    result.bytes.buffer,
    result.bytes.byteOffset,
    result.bytes.byteLength,
  );
  for (let offset = 44; offset < result.bytes.byteLength; offset += 4) {
    expect(view.getInt16(offset, true)).toBe(1000);
    expect(view.getInt16(offset + 2, true)).toBe(-1000);
  }
});
