import { afterEach, expect, test, vi } from "vite-plus/test";
import { createStack } from "./stack";
import type { AudioMiddleware, AudioSegmentMeta } from "./types";

const meta: AudioSegmentMeta = {
  index: 0,
  startOffsetMs: 0,
  durationMs: 100,
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
  },
};

/** Runs one segment through the stack, as the SDK does. */
async function run(stack: AudioMiddleware<any, any>[], segment: Uint8Array) {
  const next = (layer: number) => async (s: unknown, m: AudioSegmentMeta) =>
    layer === stack.length
      ? { segment: s as Uint8Array, meta: m }
      : stack[layer](s, m, next(layer + 1));
  return next(0)(segment, meta);
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[
    Symbol.for("braintrust.audio")
  ];
  vi.resetModules();
});

test("opus in ogg encodes a PCM segment into an Ogg Opus file", async () => {
  const stack = createStack({
    codec: { name: "opus", options: { bitrate: 32_000 } },
    container: { name: "ogg" },
  });
  expect(stack.map((middleware) => middleware.name)).toEqual(["opus", "ogg"]);
  const result = await run(stack, new Uint8Array(2400 * 2 * 2));
  expect(new TextDecoder().decode(result.segment.subarray(0, 4))).toBe("OggS");
  expect(result.meta).toMatchObject({
    mimeType: "audio/ogg",
    encoding: "opus",
  });
});

test("each recording gets its own middleware", () => {
  const config = { codec: { name: "opus" }, container: { name: "ogg" } };
  const [first, second] = [createStack(config), createStack(config)];
  expect(first[0]).not.toBe(second[0]);
  expect(first[1]).not.toBe(second[1]);
});

test.each([
  [
    { codec: { name: "mp3" }, container: { name: "ogg" } },
    'Unknown audio codec "mp3" (supported: "opus")',
  ],
  [
    { codec: { name: "opus" }, container: { name: "webm" } },
    'Unknown audio container "webm" (supported: "ogg")',
  ],
  [{ codec: { name: "opus" } }, 'Missing audio container (supported: "ogg")'],
  [
    { codec: { name: "toString" }, container: { name: "ogg" } },
    'Unknown audio codec "toString"',
  ],
])("rejects %j", (config, message) => {
  expect(() => createStack(config)).toThrow(message);
});

test("invalid codec options are rejected by the codec", () => {
  expect(() =>
    createStack({
      codec: { name: "opus", options: { bitrate: 0 } },
      container: { name: "ogg" },
    }),
  ).toThrow("Opus bitrate must");
});

test("importing the package registers it for the SDK; the first copy wins", async () => {
  const key = Symbol.for("braintrust.audio");
  const registry = globalThis as Record<symbol, unknown>;
  await import("./index");
  expect(registry[key]).toEqual({
    version: 1,
    createStack: expect.any(Function),
  });
  const first = registry[key];
  vi.resetModules();
  await import("./index");
  expect(registry[key]).toBe(first);
});
