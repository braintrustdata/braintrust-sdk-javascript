import opus from "@audio/encode-opus";
import { toOpusRate } from "@audio/encode-opus/core";

export async function encode(
  pcm: Int16Array,
  sampleRate: number,
  channels: number,
) {
  function* chunks() {
    const size = (sampleRate / 10) * channels;
    for (let at = 0; at < pcm.length; at += size) {
      yield pcm.subarray(at, at + size);
    }
  }
  return encodeChunks(chunks(), sampleRate, channels);
}

/** Preserve the codec's Lanczos filter across blocks using three samples of
 * history and lookahead. Only the beginning/end of the file clamp the filter. */
function* planarBlocks(
  chunks: Iterable<Int16Array>,
  sampleRate: number,
  channels: number,
) {
  if (![24000, 48000].includes(sampleRate)) {
    throw new Error("unsupported_codec_rate");
  }
  const tail = Array.from({ length: channels }, () => new Float32Array(6));
  let retained = 3,
    initialized = false;
  let input: Float32Array[] = [],
    output: Float32Array[] = [];
  function convert(length: number, end: number) {
    const interleaved = toOpusRate(
      input.map((c) => c.subarray(0, length)),
      sampleRate,
    );
    const ratio = 48000 / sampleRate,
      count = (end - 3) * ratio;
    if (!output.length || output[0].length < count) {
      output = Array.from({ length: channels }, () => new Float32Array(count));
    }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < channels; c++) {
        output[c][i] = interleaved[(i + 3 * ratio) * channels + c];
      }
    }
    return output.map((c) => c.subarray(0, count));
  }
  for (const pcm of chunks) {
    if (!pcm.length) {
      continue;
    }
    const length = retained + pcm.length / channels;
    if (!input.length || input[0].length < length) {
      input = Array.from({ length: channels }, () => new Float32Array(length));
    }
    if (!initialized) {
      for (let c = 0; c < channels; c++) {
        tail[c].fill(pcm[c] / 32768, 0, 3);
      }
      initialized = true;
    }
    for (let c = 0; c < channels; c++) {
      input[c].set(tail[c].subarray(0, retained));
      for (let i = 0; i < pcm.length / channels; i++) {
        input[c][retained + i] = pcm[i * channels + c] / 32768;
      }
    }
    const end = Math.max(3, length - 3);
    if (end > 3) {
      yield convert(length, end);
    }
    retained = length - end + 3;
    for (let c = 0; c < channels; c++) {
      tail[c].set(input[c].subarray(end - 3, length));
    }
  }
  if (initialized) {
    for (let c = 0; c < channels; c++) {
      input[c].set(tail[c].subarray(0, retained));
    }
    yield convert(retained, retained);
  }
}

/** Worker-only streaming codec. Blocks are consumed before advancing input. */
export async function encodeChunks(
  chunks: Iterable<Int16Array>,
  sampleRate: number,
  channels: number,
) {
  const encoder = await opus({
    sampleRate: 48000,
    channels,
    bitrate: 64,
    complexity: 5,
    application: "audio",
  });
  try {
    const pages: Uint8Array[] = [];
    let length = 0;
    for (const planar of planarBlocks(chunks, sampleRate, channels)) {
      const page = encoder.encode(planar);
      pages.push(page);
      length += page.length;
    }
    const last = encoder.flush();
    pages.push(last);
    length += last.length;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const page of pages) {
      bytes.set(page, offset);
      offset += page.length;
    }
    return { bytes, mimeType: "audio/ogg", sampleRate: 48000 };
  } finally {
    encoder.free();
  }
}
