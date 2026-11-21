import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { audioAttachment, encodeAudioAttachments } from "./audio-attachments";
import { _exportsForTestingOnly } from "./audio-compression";
import type { AudioMiddleware } from "./audio-middleware";
import { configureNode } from "./node/config";
import { Attachment } from "./logger/core";
configureNode();
const key = Symbol.for("braintrust.audio");
const globals = globalThis as Record<symbol, unknown>;
let original: unknown;
beforeEach(() => {
  original = globals[key];
  _exportsForTestingOnly.reset();
});
afterEach(() => {
  globals[key] = original;
  _exportsForTestingOnly.reset();
  vi.restoreAllMocks();
});
const pcm = { sampleRate: 24000, channels: 1 };
function install(middleware: () => AudioMiddleware) {
  const createStack = vi.fn(() => [middleware()]);
  globals[key] = { version: 1, createStack };
  return createStack;
}
function record(bytes: number[], filename = "speech.pcm") {
  const attachment = audioAttachment(
    new Blob([new Uint8Array(bytes)], { type: "audio/pcm" }),
    filename,
    undefined,
    pcm,
  );
  return {
    output: {
      content: [
        {
          type: "file",
          file: { filename, file_data: attachment, byte_size: bytes.length },
        },
      ],
    },
  };
}

test("concurrent clips own separate encoder state, copies and files; repeated export encodes once", async () => {
  const createStack = install(() => {
    let used = false;
    return async (bytes, meta, next) => {
      expect(used).toBe(false);
      used = true;
      await new Promise((resolve) => setTimeout(resolve, bytes[0]));
      return next(new Uint8Array([79, 103, 103, bytes[0]]), {
        ...meta,
        mimeType: "audio/ogg",
        encoding: "opus",
      });
    };
  });
  const a = record([8, 0, 8, 0], "first.pcm");
  const b = record([1, 0, 1, 0], "second.pcm");
  expect(createStack).not.toHaveBeenCalled();
  const [first, second, repeat] = await Promise.all([
    encodeAudioAttachments(a),
    encodeAudioAttachments(b),
    encodeAudioAttachments(a),
  ]);
  expect(createStack).toHaveBeenCalledTimes(2);
  const file = (r: typeof a) => r.output.content[0].file;
  expect(file(first).filename).toBe("first.ogg");
  expect(file(second).filename).toBe("second.ogg");
  expect(file(first).file_data).toBe(file(repeat).file_data);
  expect(file(first).file_data.reference.key).not.toBe(
    file(second).file_data.reference.key,
  );
  expect(
    new Uint8Array(await (await file(first).file_data.data()).arrayBuffer()),
  ).toEqual(new Uint8Array([79, 103, 103, 8]));
  expect(
    new Uint8Array(await (await file(second).file_data.data()).arrayBuffer()),
  ).toEqual(new Uint8Array([79, 103, 103, 1]));
  expect(file(a).filename).toBe("first.pcm");
  expect(JSON.stringify(first)).not.toContain(file(a).file_data.reference.key);
});

test("one codec failure preserves that original without corrupting another clip", async () => {
  install(() => async (bytes, meta, next) => {
    if (bytes[0] === 1) throw Error("codec failure");
    return next(bytes, { ...meta, mimeType: "audio/ogg", encoding: "opus" });
  });
  const bad = record([1, 0]);
  const good = record([2, 0]);
  const [failed, encoded] = await Promise.all([
    encodeAudioAttachments(bad),
    encodeAudioAttachments(good),
  ]);
  expect(failed.output.content[0].file.file_data).toBe(
    bad.output.content[0].file.file_data,
  );
  expect(encoded.output.content[0].file.filename).toBe("speech.ogg");
});

test("PCM override, compressed media, and removed attachments never invoke the encoder", async () => {
  const createStack = install(
    () => async (bytes, meta, next) => next(bytes, meta),
  );
  const pcmFile = audioAttachment(
    new Blob([new Uint8Array([1, 0])], { type: "audio/pcm" }),
    "raw.pcm",
    { codec: { name: "pcm" } },
    pcm,
  );
  const mp3 = audioAttachment(
    new Blob([new Uint8Array([1, 0])], { type: "audio/mpeg" }),
    "voice.mp3",
  );
  record([1, 0]); // Removed by export customization: never traversed or encoded.
  const result = await encodeAudioAttachments({ input: [pcmFile, mp3] });
  expect(result.input).toEqual([pcmFile, mp3]);
  expect(createStack).not.toHaveBeenCalled();
});

test.each([false, true])(
  "declared PCM WAV (streaming header=%s) uses its own format and leaves application bytes intact",
  async (streaming) => {
    let observed: unknown;
    install(() => async (bytes, meta, next) => {
      observed = {
        bytes: [...bytes],
        rate: meta.sampleRate,
        channels: meta.channels.length,
      };
      return next(new Uint8Array([79, 103, 103]), {
        ...meta,
        mimeType: "audio/ogg",
        encoding: "opus",
      });
    });
    const wav = new Uint8Array(48);
    const view = new DataView(wav.buffer);
    wav.set(new TextEncoder().encode("RIFF"));
    view.setUint32(4, 40, true);
    wav.set(new TextEncoder().encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 192000, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    wav.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, 4, true);
    wav.set([1, 0, 2, 0], 44);
    if (streaming) {
      view.setUint32(4, 0xffffffff, true);
      view.setUint32(40, 0xffffffff, true);
    }
    const original = wav.slice();
    const attachment = audioAttachment(
      new Blob([wav], { type: "audio/wav" }),
      "input.wav",
    );
    const result = await encodeAudioAttachments({ input: attachment });
    expect(result.input.reference.content_type).toBe("audio/ogg");
    expect(observed).toEqual({ bytes: [1, 0, 2, 0], rate: 48000, channels: 2 });
    expect(wav).toEqual(original);
  },
);

test("malformed WAV and PCM with unknown format preserve their original bytes", async () => {
  const transform = vi.fn<AudioMiddleware>(async (bytes, meta, next) =>
    next(bytes, meta),
  );
  install(() => transform);
  const input = [
    audioAttachment(new Blob(["invalid"], { type: "audio/wav" }), "bad.wav"),
    audioAttachment(
      new Blob(["unknown"], { type: "audio/pcm" }),
      "unknown.pcm",
    ),
  ];
  expect((await encodeAudioAttachments({ input })).input).toEqual(input);
  expect(transform).not.toHaveBeenCalled();
  expect(input.every((a) => a instanceof Attachment)).toBe(true);
});
