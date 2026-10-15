import { expect, test } from "vitest";
import { OggOpusDecoder } from "ogg-opus-decoder";
import { encode, encodeChunks } from "./encoder";
import opus from "@audio/encode-opus";
test("independently decodable Ogg segments preserve channels, length and reduce speech-like PCM size", async () => {
  for (const length of [5280, 24000, 24001, 24000 * 3 + 123]) {
    const pcm = new Int16Array(length * 2);
    for (let i = 0; i < length; i++) {
      pcm[i * 2] = Math.round(
        Math.sin((i / 24000) * 2 * Math.PI * 220) * 10000,
      );
      pcm[i * 2 + 1] = Math.round(
        Math.sin((i / 24000) * 2 * Math.PI * 440) * 5000,
      );
    }
    const encoded = await encode(pcm, 24000, 2);
    expect(Buffer.from(encoded.bytes.subarray(0, 4)).toString()).toBe("OggS");
    const decoder = new OggOpusDecoder();
    await decoder.ready;
    try {
      const decoded = await decoder.decodeFile(encoded.bytes);
      expect(decoded.errors).toHaveLength(0);
      expect(decoded.channelData).toHaveLength(2);
      const data = Buffer.from(encoded.bytes);
      const pages: number[] = [];
      for (let at = 0; at < data.length; ) {
        expect(data.toString("ascii", at, at + 4)).toBe("OggS");
        pages.push(at);
        const count = data[at + 26];
        at +=
          27 +
          count +
          data
            .subarray(at + 27, at + 27 + count)
            .reduce((sum, n) => sum + n, 0);
      }
      const last = pages.at(-1)!;
      const preSkip = data.readUInt16LE(27 + data[26] + 10);
      expect(data[last + 5] & 4).toBe(4);
      expect(Number(data.readBigUInt64LE(last + 6)) - preSkip).toBe(length * 2);
      // ogg-opus-decoder 1.7.3 incorrectly retains pre-skip in its end trim
      // when the only audio page is EOS. libsndfile independently decodes
      // the 220ms case to its exact duration. Restrict the known
      // decoder discrepancy to that layout, never allow missing samples.
      if (pages.length === 3) {
        expect([length * 2, length * 2 + preSkip]).toContain(
          decoded.samplesDecoded,
        );
      } else {
        expect(decoded.samplesDecoded).toBe(length * 2);
      }
      expect(
        Math.max(...decoded.channelData[0].subarray(1000, 2000)),
      ).toBeGreaterThan(0.2);
      expect(encoded.bytes.length).toBeLessThan(pcm.byteLength / 3);
    } finally {
      decoder.free();
    }
  }
});

test("streaming native-rate blocks decode identically across processing boundaries and the final tail", async () => {
  const { encodeChunks } = await import("./encoder");
  const pcm = new Int16Array((48000 * 6 + 17) * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    pcm[i * 2] = Math.round(11000 * Math.sin((i * Math.PI * 2 * 317) / 48000));
    pcm[i * 2 + 1] =
      i < 48000 || i > 48000 * 4
        ? 0
        : Math.round(6000 * Math.sin((i * Math.PI * 2 * 571) / 48000));
  }
  function* chunks() {
    for (let i = 0; i < pcm.length; i += 1234) {
      yield pcm.subarray(i, i + 1234);
    }
  }
  const complete = await encode(pcm, 48000, 2),
    streamed = await encodeChunks(chunks(), 48000, 2);
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const reference = await decoder.decodeFile(complete.bytes);
    await decoder.reset();
    const result = await decoder.decodeFile(streamed.bytes);
    expect(result.errors).toEqual([]);
    expect(result.samplesDecoded).toBe(pcm.length / 2);
    for (let channel = 0; channel < 2; channel++) {
      expect(
        Buffer.from(result.channelData[channel].buffer).equals(
          Buffer.from(reference.channelData[channel].buffer),
        ),
      ).toBe(true);
    }
  } finally {
    decoder.free();
  }
});

test("streamed resampling preserves whole-file encoding across boundaries and short tails", async () => {
  for (const length of [1, 2, 3, 24001, 24002, 24003, 72123]) {
    const pcm = new Int16Array(length * 2);
    const planar = [new Float32Array(length), new Float32Array(length)];
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < 2; c++) {
        pcm[i * 2 + c] = Math.round(9000 * Math.sin(i * (c ? 1.7 : 0.13)));
        planar[c][i] = pcm[i * 2 + c] / 32768;
      }
    }
    const original = await opus({
      sampleRate: 24000,
      channels: 2,
      bitrate: 64,
      complexity: 5,
      application: "audio",
    });
    let referenceBytes: Uint8Array;
    try {
      referenceBytes = Buffer.concat([
        original.encode(planar),
        original.flush(),
      ]);
    } finally {
      original.free();
    }
    function* chunks() {
      for (let i = 0; i < pcm.length; i += 4800) {
        yield pcm.subarray(i, i + 4800);
      }
    }
    const streamed = await encodeChunks(chunks(), 24000, 2);
    const decoder = new OggOpusDecoder();
    await decoder.ready;
    try {
      const reference = await decoder.decodeFile(referenceBytes);
      await decoder.reset();
      const result = await decoder.decodeFile(streamed.bytes);
      expect(result.errors).toEqual([]);
      expect(result.samplesDecoded).toBe(reference.samplesDecoded);
      for (let c = 0; c < 2; c++) {
        expect(
          Buffer.from(result.channelData[c].buffer).equals(
            Buffer.from(reference.channelData[c].buffer),
          ),
        ).toBe(true);
      }
    } finally {
      decoder.free();
    }
  }
});
