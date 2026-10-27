import { expect, test } from "vitest";
import oggOpus from "@audio/encode-opus";
import { OggOpusDecoder } from "ogg-opus-decoder";
import type { AudioSegmentMeta } from "./types";
import { ogg } from "./ogg";
import { opus } from "./opus";
import type { EncodedPackets } from "./packets";

const meta = (frames: number): AudioSegmentMeta => ({
  index: 1,
  startOffsetMs: 3000,
  durationMs: frames / 24,
  sampleRate: 24000,
  channelCount: 2,
  sources: [
    { channel: 0, name: "session_input" },
    { channel: 1, name: "local_audio_output" },
  ],
  mimeType: "audio/pcm",
  encoding: "s16le",
});

/** Speech-like tones at 24 kHz, a different pitch per channel. */
function tones(frames: number) {
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++)
      pcm[i * 2 + c] = Math.round(
        9000 * Math.sin((2 * Math.PI * (220 + 110 * c) * i) / 24000),
      );
  return pcm;
}

/** Runs the opus() → ogg() stack and returns the file it produces. */
async function encodeOgg(pcm: Int16Array, input: AudioSegmentMeta) {
  return opus()(
    new Uint8Array(pcm.buffer),
    input,
    async (packets, packetMeta) =>
      ogg()(packets, packetMeta, async (segment, meta) => ({ segment, meta })),
  );
}

async function decode(file: Uint8Array) {
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    return await decoder.decodeFile(file);
  } finally {
    decoder.free();
  }
}

/** Pages with their header fields, verifying each page's CRC. */
function pages(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const result: { flags: number; granule: number; crcValid: boolean }[] = [];
  for (let at = 0; at < file.length; ) {
    expect(new TextDecoder().decode(file.subarray(at, at + 4))).toBe("OggS");
    const count = file[at + 26];
    const size = file
      .subarray(at + 27, at + 27 + count)
      .reduce((sum, n) => sum + n, 27 + count);
    const page = file.slice(at, at + size);
    const crc = view.getUint32(at + 22, true);
    page.fill(0, 22, 26);
    result.push({
      flags: file[at + 5],
      granule: Number(view.getBigUint64(at + 6, true)),
      crcValid: crc === crc32(page),
    });
    at += size;
  }
  return result;
}

function crc32(bytes: Uint8Array) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let j = 0; j < 8; j++)
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc;
}

test.each([2400, 24001, 72123, 5 * 24000])(
  "%i frames decode to the reference encoder's audio, exactly as long as the input",
  async (frames) => {
    const pcm = tones(frames);
    const { segment: file } = await encodeOgg(pcm, meta(frames));
    const decoded = await decode(file);
    expect(decoded.errors).toEqual([]);
    expect(decoded.channelData).toHaveLength(2);

    const encoder = await oggOpus({
      sampleRate: 24000,
      channels: 2,
      bitrate: 64,
      complexity: 5,
      application: "audio",
    });
    let reference: Awaited<ReturnType<typeof decode>>;
    try {
      const planar = [0, 1].map((c) =>
        Float32Array.from({ length: frames }, (_, i) => pcm[i * 2 + c] / 32768),
      );
      const parts = [encoder.encode(planar), encoder.flush()];
      reference = await decode(Uint8Array.from([...parts[0], ...parts[1]]));
    } finally {
      encoder.free();
    }
    expect(decoded.samplesDecoded).toBe(reference.samplesDecoded);
    for (const c of [0, 1])
      expect(decoded.channelData[c]).toEqual(reference.channelData[c]);

    // The final granule trims padding: 48 kHz input length plus the pre-skip.
    const preSkip = new DataView(file.buffer).getUint16(28 + 10, true);
    const layout = pages(file);
    expect(layout.at(-1)!.granule - preSkip).toBe(frames * 2);
  },
);

test("pages follow RFC 7845: headers alone, then audio, with valid CRCs", async () => {
  const frames = 3 * 24000;
  const { segment: file } = await encodeOgg(tones(frames), meta(frames));
  const layout = pages(file);
  expect(layout.every((page) => page.crcValid)).toBe(true);
  expect(layout[0]).toMatchObject({ flags: 0x02, granule: 0 }); // OpusHead
  expect(layout[1]).toMatchObject({ flags: 0, granule: 0 }); // OpusTags
  expect(layout.slice(2, -1).every((page) => page.flags === 0)).toBe(true);
  expect(layout.at(-1)!.flags).toBe(0x04);
  // Granules increase page by page, each page holding at most a second of audio.
  const granules = layout.slice(2).map((page) => page.granule);
  for (const [i, granule] of granules.entries())
    expect(granule - (granules[i - 1] ?? 0)).toBeLessThanOrEqual(48000);
  expect(new TextDecoder().decode(file.subarray(28, 36))).toBe("OpusHead");
});

test("metadata becomes an Ogg file on the same timeline and sources", async () => {
  const input = meta(2400);
  const { meta: output } = await encodeOgg(tones(2400), input);
  expect(output).toEqual({
    ...input,
    sampleRate: 48000,
    mimeType: "audio/ogg",
    encoding: "opus",
  });
});

test.each([
  ["raw bytes", new Uint8Array(4)],
  [
    "another codec",
    { codec: "vorbis", headers: [], packets: [], delay: 0, padding: 0 },
  ],
])("rejects %s", (_name, segment) => {
  expect(() =>
    ogg()(segment as EncodedPackets, meta(1), () => {
      throw new Error("next must not run");
    }),
  ).toThrow(/ogg requires Opus packets/);
});
