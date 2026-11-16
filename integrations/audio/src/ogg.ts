import type { AudioMiddleware } from "./types";
import type { EncodedPackets } from "./packets";

/** A page closes past 4 KB or one second of 20 ms packets, as libogg pages Opus. */
const PAGE_BYTES = 4096;
const PAGE_PACKETS = 50;
const MAX_SEGMENTS = 255;
const BOS = 0x02;
const EOS = 0x04;

/**
 * Wraps encoded packets in a self-contained Ogg file (RFC 7845 for Opus).
 * Place it after an encoder such as `opus()`.
 */
export function ogg(): AudioMiddleware<EncodedPackets, Uint8Array> {
  return function ogg(segment, meta, next) {
    if (segment?.codec !== "opus" || !segment.headers?.[0])
      throw new Error("ogg requires Opus packets, such as from opus()");
    const serial = Math.floor(Math.random() * 2 ** 32);
    const pages: Uint8Array[] = [];
    const page = (packets: Uint8Array[], granule: number, flags = 0) =>
      pages.push(oggPage(packets, granule, flags, serial, pages.length));
    page([segment.headers[0]], 0, BOS);
    page([opusTags()], 0);

    let queue: Uint8Array[] = [];
    let bytes = 0;
    let segments = 0;
    let granule = 0;
    for (const [i, packet] of segment.packets.entries()) {
      const lacing = Math.floor(packet.data.length / 255) + 1;
      if (
        queue.length &&
        (queue.length >= PAGE_PACKETS ||
          bytes + packet.data.length > PAGE_BYTES ||
          segments + lacing > MAX_SEGMENTS)
      ) {
        page(queue, granule);
        queue = [];
        bytes = segments = 0;
      }
      queue.push(packet.data);
      bytes += packet.data.length;
      segments += lacing;
      granule += packet.samples;
      // The last page's granule trims the padding (RFC 7845 §4.4).
      if (i === segment.packets.length - 1)
        page(queue, granule - segment.padding, EOS);
    }
    return next(concat(pages), { ...meta, mimeType: "audio/ogg" });
  };
}

function splitPages(stream: Uint8Array): Uint8Array[] {
  const pages: Uint8Array[] = [];
  for (let pos = 0; pos < stream.length;) {
    if (String.fromCharCode(...stream.subarray(pos, pos + 4)) !== "OggS")
      throw new Error(`Malformed Ogg page at byte ${pos}`);
    const bodyStart = pos + 27 + (stream[pos + 26] ?? 0);
    let end = bodyStart;
    for (let i = pos + 27; i < bodyStart && i < stream.length; i++)
      end += stream[i];
    if (end > stream.length)
      throw new Error(`Truncated Ogg page at byte ${pos}`);
    pages.push(new Uint8Array(stream.subarray(pos, end)));
    pos = end;
  }
  return pages;
}

function body(page: Uint8Array | undefined): Uint8Array {
  return page ? page.subarray(27 + page[26]) : new Uint8Array();
}

function magic(page: Uint8Array | undefined): string {
  return String.fromCharCode(...body(page).subarray(0, 8));
}

/**
 * Joins Ogg Opus files, such as a recording's segments, into one logical
 * stream. Appended files form a chained Ogg, which many decoders probe as only
 * the last file's length. Assumes each file has OpusHead and OpusTags on one
 * page each, then 20 ms packets.
 */
export function joinOggStreams(streams: Uint8Array[]): Uint8Array {
  if (!streams.length) throw new Error("No Ogg streams to join");
  const pages: Uint8Array[] = [];
  let sampleOffset = 0;
  streams.forEach((stream, index) => {
    const [head, tags, ...audio] = splitPages(stream);
    if (magic(head) !== "OpusHead" || magic(tags) !== "OpusTags")
      throw new Error(`Ogg stream ${index} doesn't start with Opus headers`);
    if (tags[26 + tags[26]] === 255)
      throw new Error(`Ogg stream ${index} has OpusTags over several pages`);
    if (index === 0) pages.push(head, tags);
    else if (
      body(head)[9] !== body(pages[0])[9] ||
      body(head)[18] !== body(pages[0])[18]
    )
      throw new Error(`Ogg stream ${index} has a different channel layout`);
    let granule = 0;
    for (const page of audio) {
      const view = new DataView(page.buffer);
      granule = Number(view.getBigUint64(6, true));
      view.setBigUint64(6, BigInt(sampleOffset + granule), true);
      pages.push(page);
    }
    // Every packet is kept, so the next stream starts after this one's padding.
    const samples = Math.ceil(granule / 960) * 960;
    if (index < streams.length - 1)
      new DataView(pages[pages.length - 1].buffer).setBigUint64(
        6,
        BigInt(sampleOffset + samples),
        true,
      );
    sampleOffset += samples;
  });

  const serial = new DataView(pages[0].buffer).getUint32(14, true);
  pages.forEach((page, sequence) => {
    const view = new DataView(page.buffer);
    page[5] =
      (page[5] & 0x01) |
      (sequence === 0 ? BOS : 0) |
      (sequence === pages.length - 1 ? EOS : 0);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    view.setUint32(22, 0, true);
    view.setUint32(22, crc32(page), true);
  });
  return concat(pages);
}

/** Opus comment header with no tags (RFC 7845 §5.2). */
function opusTags() {
  const vendor = new TextEncoder().encode("@braintrust/audio");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode("OpusTags"));
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true); // user comment count
  return tags;
}

/** One page of whole packets (RFC 3533). */
function oggPage(
  packets: Uint8Array[],
  granule: number,
  flags: number,
  serial: number,
  sequence: number,
) {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let n = packet.length; n >= 255; n -= 255) lacing.push(255);
    lacing.push(packet.length % 255);
  }
  const header = 27 + lacing.length;
  const page = new Uint8Array(
    header + packets.reduce((sum, packet) => sum + packet.length, 0),
  );
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  page[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = header;
  for (const packet of packets) {
    page.set(packet, at);
    at += packet.length;
  }
  view.setUint32(22, crc32(page), true);
  return page;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let j = 0; j < 8; j++)
    r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, zero initial value. */
function crc32(bytes: Uint8Array) {
  let crc = 0;
  for (const byte of bytes)
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
