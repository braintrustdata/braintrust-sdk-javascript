const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let bit = 0; bit < 8; bit++) {
    r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  }
  return r >>> 0;
});

function crc(page: Uint8Array): number {
  let c = 0;
  for (const byte of page) {
    c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return c;
}

function splitPages(stream: Uint8Array): Uint8Array[] {
  const pages: Uint8Array[] = [];
  for (let pos = 0; pos < stream.length; ) {
    if (String.fromCharCode(...stream.subarray(pos, pos + 4)) !== "OggS") {
      throw new Error(`Malformed Ogg page at byte ${pos}`);
    }
    const body = pos + 27 + (stream[pos + 26] ?? 0);
    let end = body;
    for (let i = pos + 27; i < body && i < stream.length; i++) {
      end += stream[i];
    }
    if (body > stream.length || end > stream.length) {
      throw new Error(`Truncated Ogg page at byte ${pos}`);
    }
    pages.push(stream.slice(pos, end));
    pos = end;
  }
  return pages;
}

function packet(page: Uint8Array | undefined): Uint8Array {
  return page ? page.subarray(27 + page[26]) : new Uint8Array();
}

function magic(page: Uint8Array | undefined): string {
  return String.fromCharCode(...packet(page).subarray(0, 8));
}

/**
 * Joins the SDK's Ogg Opus segments into one logical stream, like
 * `ffmpeg -f concat -c copy`. Appending the files instead gives a chained Ogg,
 * whose probed duration is only the last segment's, and Gemini decodes only
 * that much.
 */
export function joinOggStreams(streams: Uint8Array[]): Uint8Array {
  const pages: Uint8Array[] = [];
  let offset = 0;
  streams.forEach((stream, index) => {
    const [head, tags, ...audio] = splitPages(stream);
    if (magic(head) !== "OpusHead" || magic(tags) !== "OpusTags") {
      throw new Error(`Ogg stream ${index} doesn't start with Opus headers`);
    }
    const [channels, mapping] = [packet(head)[9], packet(head)[18]];
    if (
      index > 0 &&
      (channels !== packet(pages[0])[9] || mapping !== packet(pages[0])[18])
    ) {
      throw new Error(`Ogg stream ${index} has a different channel layout`);
    }
    if (index === 0) {
      pages.push(head, tags);
    }
    let end = 0;
    for (const page of audio) {
      const view = new DataView(page.buffer);
      end = view.getUint32(10, true) * 2 ** 32 + view.getUint32(6, true);
      setGranule(view, offset + end);
      pages.push(page);
    }
    // Every packet is kept, so the next stream starts after this one's
    // padding. The SDK writes 20 ms packets, 960 samples each.
    const decoded = Math.ceil(end / 960) * 960;
    if (index < streams.length - 1) {
      setGranule(
        new DataView(pages[pages.length - 1].buffer),
        offset + decoded,
      );
    }
    offset += decoded;
  });

  const serial = new DataView(pages[0].buffer).getUint32(14, true);
  pages.forEach((page, sequence) => {
    const view = new DataView(page.buffer);
    page[5] =
      (sequence === 0 ? 0x02 : 0) | (sequence === pages.length - 1 ? 0x04 : 0);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    view.setUint32(22, 0, true);
    view.setUint32(22, crc(page), true);
  });
  return Buffer.concat(pages);
}

function setGranule(view: DataView, granule: number) {
  view.setUint32(6, granule % 2 ** 32, true);
  view.setUint32(10, Math.floor(granule / 2 ** 32), true);
}
