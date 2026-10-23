import { expect, test, vi } from "vitest";
import {
  runMiddleware,
  type AudioMiddleware,
  type AudioSegmentMeta,
} from "./audio-middleware";

const meta: AudioSegmentMeta = {
  index: 3,
  startOffsetMs: 1000,
  durationMs: 2,
  sampleRate: 1000,
  channelCount: 2,
  sources: [
    { channel: 0, name: "a" },
    { channel: 1, name: "b" },
  ],
  mimeType: "audio/pcm",
  encoding: "s16le",
};
/** Two stereo frames: a = [2, 4], b = [6, 8]. */
const pcm = () => new Uint8Array(Int16Array.from([2, 6, 4, 8]).buffer);
const samples = (data: Uint8Array) =>
  Array.from(new Int16Array(data.slice().buffer));

test("without middleware, the segment and metadata come back unchanged", async () => {
  const result = await runMiddleware([], pcm(), meta);
  expect(samples(result.segment)).toEqual([2, 6, 4, 8]);
  expect(result.meta).toEqual(meta);
});

test("middleware runs outermost first, transforms input and observes results on the way back", async () => {
  const calls: string[] = [];
  const outer: AudioMiddleware = async (segment, meta, next) => {
    calls.push(`outer in ${meta.encoding}`);
    const result = await next(segment, meta);
    calls.push(`outer out ${result.meta.encoding}`);
    return result;
  };
  const reverse: AudioMiddleware = async (segment, meta, next) => {
    calls.push(`reverse in ${meta.encoding}`);
    const result = await next(segment.slice().reverse(), {
      ...meta,
      encoding: "reversed",
      mimeType: "application/octet-stream",
    });
    calls.push(`reverse out ${result.meta.encoding}`);
    return result;
  };
  const result = await runMiddleware([outer, reverse], pcm(), meta);
  expect(calls).toEqual([
    "outer in s16le",
    "reverse in s16le",
    "reverse out reversed",
    "outer out reversed",
  ]);
  expect([...result.segment]).toEqual([...pcm()].reverse());
  expect(result.meta).toMatchObject({
    index: 3,
    startOffsetMs: 1000,
    encoding: "reversed",
    mimeType: "application/octet-stream",
  });
});

test("middleware can short-circuit the rest of the stack", async () => {
  const skipped = vi.fn<AudioMiddleware>();
  const replace: AudioMiddleware = (_segment, meta) => ({
    segment: Uint8Array.of(7),
    meta: { ...meta, encoding: "replaced" },
  });
  const result = await runMiddleware([replace, skipped], pcm(), meta);
  expect(skipped).not.toHaveBeenCalled();
  expect([...result.segment]).toEqual([7]);
  expect(result.meta.encoding).toBe("replaced");
});

test("attributes and state pass custom values to later middleware and the result", async () => {
  let seen: unknown[] = [];
  const tag: AudioMiddleware = (segment, meta, next) =>
    next(segment, {
      ...meta,
      attributes: { ...meta.attributes, "acme.key_id": "k-1" },
      state: { ...meta.state, "acme.key": Uint8Array.of(1, 2) },
    });
  const read: AudioMiddleware = (segment, meta, next) => {
    seen = [meta.attributes?.["acme.key_id"], meta.state?.["acme.key"]];
    return next(segment, meta);
  };
  const result = await runMiddleware([tag, read], pcm(), meta);
  expect(seen).toEqual(["k-1", Uint8Array.of(1, 2)]);
  expect(result.meta).toMatchObject({
    attributes: { "acme.key_id": "k-1" },
    state: { "acme.key": Uint8Array.of(1, 2) },
  });
});

test("segments passed down may take any form; the stack must end with bytes", async () => {
  type Words = { words: string[] };
  const split: AudioMiddleware<Uint8Array, Words> = (segment, meta, next) =>
    next({ words: ["two", "frames", String(segment.length)] }, meta);
  const join: AudioMiddleware<Words, Uint8Array> = (segment, meta, next) =>
    next(new TextEncoder().encode(segment.words.join(" ")), {
      ...meta,
      mimeType: "text/plain",
    });
  const result = await runMiddleware([split, join], pcm(), meta);
  expect(new TextDecoder().decode(result.segment)).toBe("two frames 8");
  await expect(runMiddleware([split], pcm(), meta)).rejects.toThrow(
    "invalid_audio_middleware_result",
  );
});

test("middleware that changes the layout describes it in the metadata", async () => {
  // Averages the two channels into one, keeping every source on channel 0.
  const mixdown: AudioMiddleware = (segment, meta, next) => {
    const stereo = new Int16Array(segment.slice().buffer);
    const mono = Int16Array.from(
      { length: stereo.length / 2 },
      (_, i) => (stereo[i * 2] + stereo[i * 2 + 1]) / 2,
    );
    return next(new Uint8Array(mono.buffer), {
      ...meta,
      channelCount: 1,
      sources: meta.sources.map((source) => ({ ...source, channel: 0 })),
    });
  };
  const result = await runMiddleware([mixdown], pcm(), meta);
  expect(samples(result.segment)).toEqual([4, 6]);
  expect(result.meta).toMatchObject({
    channelCount: 1,
    sources: [
      { channel: 0, name: "a" },
      { channel: 0, name: "b" },
    ],
  });
});

test.each<[string, AudioMiddleware]>([
  [
    "throws",
    () => {
      throw new Error("boom");
    },
  ],
  [
    "rejects",
    async () => {
      throw new Error("boom");
    },
  ],
  [
    "mutates metadata",
    (segment, meta, next) => {
      (meta as { encoding: string }).encoding = "changed";
      return next(segment, meta);
    },
  ],
  [
    "calls next twice",
    async (segment, meta, next) => {
      await next(segment, meta);
      return next(segment, meta);
    },
  ],
  [
    "changes timeline placement",
    (segment, meta, next) =>
      next(segment, { ...meta, startOffsetMs: meta.startOffsetMs + 1 }),
  ],
  [
    "changes segment identity",
    async (segment, meta) => ({
      segment,
      meta: { ...meta, index: meta.index + 1 },
    }),
  ],
  [
    "returns a non-byte segment",
    async (_segment, meta) => ({
      segment: "pcm" as unknown as Uint8Array,
      meta,
    }),
  ],
  ["returns nothing", (async () => undefined) as unknown as AudioMiddleware],
])("middleware that %s rejects the run", async (_name, failing) => {
  await expect(runMiddleware([failing], pcm(), meta)).rejects.toThrow();
});

test("downstream failures reach middleware that ignores next() without unhandled rejections", async () => {
  const detached: AudioMiddleware = (segment, meta, next) => {
    void next(segment, meta);
    return { segment, meta };
  };
  const failing: AudioMiddleware = () => {
    throw new Error("boom");
  };
  const result = await runMiddleware([detached, failing], pcm(), meta);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(samples(result.segment)).toEqual([2, 6, 4, 8]);
});
