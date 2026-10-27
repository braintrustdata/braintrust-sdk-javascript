import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  _exportsForTestingOnly,
  audioEncodingStack,
  type AudioEncodingDefaults,
} from "./audio-compression";
import type { AudioMiddleware } from "./audio-middleware";
import iso from "./isomorph";
import { configureNode } from "./node/config";

configureNode();

const REGISTRY = Symbol.for("braintrust.audio");
const registry = globalThis as Record<symbol, unknown>;
const DEFAULTS: AudioEncodingDefaults = {
  codec: { name: "opus" },
  container: { name: "ogg" },
};
const PCM = "audio is recorded as uncompressed PCM, which can be very large.";
const tag: AudioMiddleware = (segment, meta, next) => next(segment, meta);

let warnings: string[];
let load: ReturnType<typeof vi.fn<(name: string) => unknown>>;
const original = iso.loadOptionalModule;

/** Simulates installing @braintrust/audio: loading it registers createStack. */
function install(createStack: (config: unknown) => unknown = () => [tag]) {
  load.mockImplementation(() => {
    registry[REGISTRY] = { version: 1, createStack };
    return {};
  });
  return createStack;
}

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.join(" "));
  });
  vi.stubEnv("BRAINTRUST_AUDIO_COMPRESSION", "");
  load = vi.fn(() => undefined);
  iso.loadOptionalModule = load;
});
afterEach(() => {
  delete registry[REGISTRY];
  iso.loadOptionalModule = original;
  _exportsForTestingOnly.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("installed, recordings compress with the integration's defaults", () => {
  const createStack = vi.fn(() => [tag]);
  install(createStack);
  expect(audioEncodingStack(undefined, DEFAULTS)).toEqual([tag]);
  expect(load).toHaveBeenCalledWith("@braintrust/audio");
  expect(createStack).toHaveBeenCalledWith(DEFAULTS);
  expect(warnings).toEqual([]);
});

test("configured settings win over the defaults, field by field", () => {
  const createStack = vi.fn(() => [tag]);
  install(createStack);
  const codec = { name: "opus", options: { bitrate: 32_000 } } as const;
  audioEncodingStack({ codec }, DEFAULTS);
  expect(createStack).toHaveBeenCalledWith({
    codec,
    container: DEFAULTS.container,
  });
});

test("the package loads once; each recording gets a new stack", () => {
  const createStack = vi.fn(() => [tag]);
  install(createStack);
  audioEncodingStack(undefined, DEFAULTS);
  audioEncodingStack(undefined, DEFAULTS);
  expect(load).toHaveBeenCalledTimes(1);
  expect(createStack).toHaveBeenCalledTimes(2);
});

test("an app that imports the package itself needs no loading", () => {
  registry[REGISTRY] = { version: 1, createStack: () => [tag] };
  expect(audioEncodingStack(undefined, DEFAULTS)).toEqual([tag]);
  expect(load).not.toHaveBeenCalled();
});

test.each([
  ["codec pcm", { codec: { name: "pcm" } } as const, ""],
  ["BRAINTRUST_AUDIO_COMPRESSION=false", undefined, "false"],
  ["BRAINTRUST_AUDIO_COMPRESSION=0", undefined, "0"],
])(
  "%s records raw PCM without loading or warning",
  (_name, configured, env) => {
    vi.stubEnv("BRAINTRUST_AUDIO_COMPRESSION", env);
    install();
    expect(audioEncodingStack(configured, DEFAULTS)).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  },
);

test.each(["true", "1", "", "yes"])(
  "BRAINTRUST_AUDIO_COMPRESSION=%j keeps the default",
  (env) => {
    vi.stubEnv("BRAINTRUST_AUDIO_COMPRESSION", env);
    install();
    expect(audioEncodingStack(undefined, DEFAULTS)).toEqual([tag]);
  },
);

test("a configured codec wins over BRAINTRUST_AUDIO_COMPRESSION=false", () => {
  vi.stubEnv("BRAINTRUST_AUDIO_COMPRESSION", "false");
  install();
  expect(audioEncodingStack({ codec: { name: "opus" } }, DEFAULTS)).toEqual([
    tag,
  ]);
});

test("not installed: raw PCM, warned once per process", () => {
  expect(audioEncodingStack(undefined, DEFAULTS)).toEqual([]);
  expect(audioEncodingStack(undefined, DEFAULTS)).toEqual([]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(warnings).toEqual([
    expect.stringContaining(
      `@braintrust/audio is not installed: ${PCM} Install @braintrust/audio to compress recordings.`,
    ),
  ]);
});

test("fails to load: raw PCM with the reason", () => {
  load.mockImplementation(() => {
    throw new Error("Cannot find module '@audio/encode-opus'");
  });
  expect(audioEncodingStack(undefined, DEFAULTS)).toEqual([]);
  expect(warnings).toEqual([
    expect.stringContaining(
      `@braintrust/audio failed to load (Cannot find module '@audio/encode-opus'): ${PCM} Reinstall @braintrust/audio to compress recordings.`,
    ),
  ]);
});

test.each([
  ["a newer contract", { version: 2, createStack: () => [tag] }],
  ["no factory", { version: 1 }],
])("incompatible package (%s): raw PCM", (_name, registered) => {
  load.mockImplementation(() => {
    registry[REGISTRY] = registered;
    return {};
  });
  expect(audioEncodingStack(undefined, DEFAULTS)).toEqual([]);
  expect(warnings).toEqual([
    expect.stringContaining(
      `@braintrust/audio is incompatible with this version of braintrust: ${PCM} Install matching versions of braintrust and @braintrust/audio to compress recordings.`,
    ),
  ]);
});

test("settings the package rejects: raw PCM with its explanation, warned once", () => {
  install(() => {
    throw new Error('Unknown audio codec "mp3" (supported: "opus")');
  });
  const configured = { codec: { name: "mp3" } } as never;
  expect(audioEncodingStack(configured, DEFAULTS)).toEqual([]);
  expect(audioEncodingStack(configured, DEFAULTS)).toEqual([]);
  expect(warnings).toEqual([
    expect.stringContaining(
      `Unknown audio codec "mp3" (supported: "opus"): ${PCM}`,
    ),
  ]);
});
