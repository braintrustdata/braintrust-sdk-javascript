import { expect, test } from "vite-plus/test";
import oggOpus from "@audio/encode-opus";
import { OggOpusDecoder } from "ogg-opus-decoder";
import type { AudioSegmentMeta } from "./types";
import { joinOggStreams, ogg } from "./ogg";
import { opus, type OpusOptions } from "./opus";
import type { EncodedPackets } from "./packets";

const meta = (frames: number): AudioSegmentMeta => ({
  index: 1,
  startOffsetMs: 3000,
  durationMs: frames / 24,
  sampleRate: 24000,
  channels: [
    { sources: ["session_input"] },
    { sources: ["local_audio_output"] },
  ],
  mimeType: "audio/pcm",
  encoding: "pcm",
  attributes: {
    "pcm.sample_format": "s16le",
    "pcm.channel_layout": "interleaved",
    "acme.call_id": "c-1",
  },
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
async function encodeOgg(
  pcm: Int16Array,
  input: AudioSegmentMeta,
  options?: OpusOptions,
) {
  return opus(options)(
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
  for (let at = 0; at < file.length;) {
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

test("metadata becomes an Ogg file on the same timeline and channels", async () => {
  const input = meta(2400);
  const { meta: output } = await encodeOgg(tones(2400), input);
  // The container keeps the codec and its attributes.
  expect(output).toEqual({
    ...input,
    sampleRate: 48000,
    mimeType: "audio/ogg",
    encoding: "opus",
    attributes: {
      "acme.call_id": "c-1",
      "opus.bitrate_bps": 64000,
      "opus.complexity": 5,
      "opus.application": "audio",
    },
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

/** Raw page bytes, for building and inspecting joined files. */
function pageBytes(file: Uint8Array) {
  const result: Uint8Array[] = [];
  for (let at = 0; at < file.length;) {
    const lacing = file.subarray(at + 27, at + 27 + file[at + 26]);
    const size = 27 + lacing.length + lacing.reduce((sum, n) => sum + n, 0);
    result.push(file.subarray(at, at + size));
    at += size;
  }
  return result;
}

const lacing = (page: Uint8Array) => [...page.subarray(27, 27 + page[26])];
const uint32 = (page: Uint8Array, at: number) =>
  new DataView(page.buffer, page.byteOffset).getUint32(at, true);
const granule = (page: Uint8Array) =>
  Number(new DataView(page.buffer, page.byteOffset).getBigUint64(6, true));
const concat = (parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

/** An Ogg page; the join rewrites its serial, sequence and CRC. */
function page(
  flags: number,
  granule: number,
  lacing: number[],
  body: Uint8Array,
) {
  const page = new Uint8Array(27 + lacing.length + body.length);
  page.set([0x4f, 0x67, 0x67, 0x53]);
  page[5] = flags;
  new DataView(page.buffer).setBigUint64(6, BigInt(granule), true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(body, 27 + lacing.length);
  return page;
}

async function segment(seconds: number, options?: OpusOptions, channels = 2) {
  const frames = seconds * 24000;
  const input = {
    ...meta(frames),
    channels: meta(frames).channels.slice(0, channels),
  };
  return (await encodeOgg(tones(frames), input, options)).segment;
}

test("joins a long and a short segment into one logical stream", async () => {
  const [a, b] = [await segment(60), await segment(2)];
  const joined = joinOggStreams([a, b]);
  const raw = pageBytes(joined);
  const magic = raw.map((p) =>
    new TextDecoder().decode(p.subarray(27 + p[26], 35 + p[26])),
  );
  expect(magic.filter((m) => m.startsWith("Opus"))).toEqual([
    "OpusHead",
    "OpusTags",
  ]);
  expect(new Set(raw.map((p) => uint32(p, 14))).size).toBe(1);
  expect(raw.map((p) => uint32(p, 18))).toEqual(raw.map((_, i) => i));
  const layout = pages(joined);
  expect(layout.every((p) => p.crcValid)).toBe(true);
  expect(layout.map((p) => p.flags)).toEqual(
    layout.map((_, i) => (i === 0 ? 2 : i === layout.length - 1 ? 4 : 0)),
  );
  const granules = layout.map((p) => p.granule);
  expect(granules).toEqual([...granules].sort((x, y) => x - y));
  // Segment a keeps every packet, padding included: 960 samples each.
  const samples =
    pageBytes(a)
      .slice(2)
      .flatMap(lacing)
      .filter((n) => n < 255).length * 960;
  expect(granules[pageBytes(a).length - 1]).toBe(samples);
  expect(granules.at(-1)).toBe(samples + granule(pageBytes(b).at(-1)!));
  expect((await decode(joined)).errors).toEqual([]);
});

test("leaves a single segment unchanged", async () => {
  const a = await segment(2);
  expect(joinOggStreams([a])).toEqual(a);
});

test("skips a segment with headers and no audio", async () => {
  const [a, b] = [await segment(1), await segment(1)];
  const empty = concat(pageBytes(b).slice(0, 2));
  expect(joinOggStreams([a, empty, b])).toEqual(joinOggStreams([a, b]));
});

test("keeps a packet continued across pages in a later segment", async () => {
  const [a, b] = [await segment(1), await segment(2, { bitrate: 256_000 })];
  const [head, tags, audio, ...rest] = pageBytes(b);
  const sizes = lacing(audio);
  const splitIndex = sizes.lastIndexOf(255) + 1;
  const body = audio.subarray(27 + sizes.length);
  const cut = sizes.slice(0, splitIndex).reduce((sum, n) => sum + n, 0);
  const split = concat([
    head,
    tags,
    page(
      0,
      granule(audio) - 960,
      sizes.slice(0, splitIndex),
      body.subarray(0, cut),
    ),
    page(1, granule(audio), sizes.slice(splitIndex), body.subarray(cut)),
    ...rest,
  ]);
  const joined = joinOggStreams([a, split]);
  expect(pages(joined).some((p) => p.flags & 1)).toBe(true);
  expect((await decode(joined)).channelData).toEqual(
    (await decode(joinOggStreams([a, b]))).channelData,
  );
});

test("rejects OpusTags over several pages in a later segment", async () => {
  const [a, b] = [await segment(1), await segment(1)];
  const [head, tags, ...audio] = pageBytes(b);
  const tagsBody = new Uint8Array(300);
  tagsBody.set(tags.subarray(27 + tags[26]));
  const split = concat([
    head,
    page(0, 0, [255], tagsBody.subarray(0, 255)),
    page(1, 0, [45], tagsBody.subarray(255)),
    ...audio,
  ]);
  expect(() => joinOggStreams([a, split])).toThrow(
    /OpusTags over several pages/,
  );
});

test("rejects a different channel layout", async () => {
  const [a, b] = [await segment(1, {}, 1), await segment(1)];
  expect(() => joinOggStreams([a, b])).toThrow(/different channel layout/);
});

test("rejects an empty list or non-Ogg input", () => {
  expect(() => joinOggStreams([])).toThrow(/No Ogg streams/);
  expect(() => joinOggStreams([new Uint8Array([1, 2, 3, 4, 5])])).toThrow(
    /Malformed Ogg page/,
  );
});
