import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  Attachment,
  BraintrustState,
  CAPTURE_ATTACHMENTS,
  startSpan,
  _exportsForTestingOnly,
  _internalGetGlobalState,
  initLogger,
  withCurrent,
} from "./logger";
import { configureNode } from "./node/config";
import iso from "./isomorph";
import * as byteUtils from "../util/index";
import {
  isAutoCaptureAttachmentsEnabled,
  processInputAttachments,
} from "./wrappers/attachment-utils";
import { processAttachmentsInInput } from "./instrumentation/plugins/anthropic-plugin";
import { processAISDKGenerateImageOutput } from "./instrumentation/plugins/ai-sdk-plugin";
import { extractOllamaChatInput } from "./instrumentation/plugins/ollama-plugin";
import { openAIChannels } from "./instrumentation/plugins/openai-channels";
import { elevenLabsChannels } from "./instrumentation/plugins/elevenlabs-channels";
import { groqChannels } from "./instrumentation/plugins/groq-channels";
import { googleGenAIChannels } from "./instrumentation/plugins/google-genai-channels";

configureNode();
const state = _internalGetGlobalState();
let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(() => _exportsForTestingOnly.simulateLoginForTests());
beforeEach(() => {
  vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", undefined);
  state.captureAttachments = undefined;
  state.currentLogger = undefined;
  background = _exportsForTestingOnly.useTestBackgroundLogger();
});
afterEach(async () => {
  await background.drain();
  _exportsForTestingOnly.clearTestBackgroundLogger();
  state.captureAttachments = undefined;
  state.currentLogger = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const loggerOptions = {
  projectName: "tmp-luca-capture-tests",
  projectId: "test-project-id",
};
const inlineImage = {
  type: "image_url",
  image_url: { url: "data:image/png;base64,AQID" },
};

it.each([true, false])(
  "explicit %s overrides an opposing environment setting",
  (captureAttachments) => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", String(!captureAttachments));
    const logger = initLogger({ ...loggerOptions, captureAttachments });
    expect(isAutoCaptureAttachmentsEnabled(logger)).toBe(captureAttachments);
    expect(isAutoCaptureAttachmentsEnabled()).toBe(captureAttachments);
    initLogger(loggerOptions);
    expect(isAutoCaptureAttachmentsEnabled()).toBe(captureAttachments);
  },
);

it("local loggers use the environment, and never inherit or update the global override", () => {
  initLogger({ ...loggerOptions, captureAttachments: true });
  const local = initLogger({ ...loggerOptions, setCurrent: false });
  expect(isAutoCaptureAttachmentsEnabled(local)).toBe(false);
  initLogger({
    ...loggerOptions,
    setCurrent: false,
    captureAttachments: false,
  });
  expect(isAutoCaptureAttachmentsEnabled()).toBe(true);
  vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
  initLogger({ ...loggerOptions, captureAttachments: false });
  expect(isAutoCaptureAttachmentsEnabled(local)).toBe(true);
});

it("isolates SDK state defaults", () => {
  const other = new BraintrustState({});
  initLogger({ ...loggerOptions, captureAttachments: true });
  const otherLogger = initLogger({
    ...loggerOptions,
    state: other,
    captureAttachments: false,
  });
  expect(isAutoCaptureAttachmentsEnabled(otherLogger)).toBe(false);
  expect(other._internalCaptureAttachmentsEnabled()).toBe(false);
  expect(isAutoCaptureAttachmentsEnabled()).toBe(true);
});

it("keeps concurrent local traces and descendants isolated after global replacement", async () => {
  const enabled = initLogger({
    ...loggerOptions,
    setCurrent: false,
    captureAttachments: true,
  });
  const disabled = initLogger({
    ...loggerOptions,
    setCurrent: false,
    captureAttachments: false,
  });
  await Promise.all(
    [enabled, disabled].map(async (logger, index) => {
      await logger.traced(async (parent) => {
        await Promise.resolve();
        initLogger({ ...loggerOptions, captureAttachments: index !== 0 });
        await parent.traced(async () => {
          await Promise.resolve();
          const output = processInputAttachments(inlineImage);
          if (index === 0)
            expect(output.image_url.url).toBeInstanceOf(Attachment);
          else expect(output).toBeUndefined();
        });
      });
    }),
  );
});

it("does not decode inline media, read local images, or evaluate generated binary getters when disabled", () => {
  initLogger({ ...loggerOptions, captureAttachments: false });
  const decode = vi.spyOn(globalThis, "atob");
  const stat = vi.spyOn(iso, "statSync");
  const binary = vi.fn(() => {
    throw new Error("must not access media");
  });
  expect(
    processAttachmentsInInput([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AQID" },
      },
    ]),
  ).toEqual([
    {
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    },
  ]);
  const source = Object.defineProperty(
    { type: "base64", media_type: "image/png" },
    "data",
    { get: binary, enumerable: true },
  );
  expect(processAttachmentsInInput({ type: "image", source })).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png" },
  });
  const image = Object.defineProperty({ mediaType: "image/png" }, "base64", {
    get: binary,
  });
  expect(processAISDKGenerateImageOutput({ images: [image] }, [])).toEqual({});
  expect(
    extractOllamaChatInput([
      {
        model: "model",
        messages: [
          { role: "user", content: "look", images: ["/tmp/private.png"] },
        ],
      },
    ]).input,
  ).toEqual([
    {
      role: "user",
      content: "look",
    },
  ]);
  expect(decode).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  expect(binary).not.toHaveBeenCalled();
});

it("preserves explicit attachments and remote references with capture disabled", async () => {
  const logger = initLogger({ ...loggerOptions, captureAttachments: false });
  const attachment = new Attachment({
    data: new Blob(["explicit"]),
    filename: "explicit.txt",
    contentType: "text/plain",
  });
  logger.log({ input: { attachment } });
  const rows = (await background.drain()) as Array<{
    input?: unknown;
    output?: unknown;
    metrics?: Record<string, number>;
  }>;
  expect(
    rows.some(
      (row) =>
        (row.input as { attachment?: unknown })?.attachment === attachment,
    ),
  ).toBe(true);
  const attachments: Attachment[] = [];
  const event = { input: { attachment } };
  _exportsForTestingOnly.extractAttachments(event, attachments);
  expect(attachments).toEqual([attachment]);
  expect(
    processInputAttachments({
      ...inlineImage,
      image_url: { url: "https://example.com/image.png" },
    }).image_url.url,
  ).toBe("https://example.com/image.png");
});

it.each([true, false])(
  "retains a local policy (%s) when consuming an OpenAI stream outside its trace",
  async (captureAttachments) => {
    const local = initLogger({
      ...loggerOptions,
      setCurrent: false,
      captureAttachments,
    });
    async function* events() {
      yield {
        type: "image_generation.completed",
        b64_json: "AQID",
        output_format: "png",
      };
    }
    const stream = await local.traced(() =>
      openAIChannels.imagesGenerate.invoke(
        async () => events(),
        undefined,
        [{ prompt: "draw", stream: true }],
        {},
      ),
    );
    initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
    for await (const event of stream as AsyncIterable<unknown>)
      expect(event).toBeDefined();
    const rows = (await background.drain()) as Array<{
      input?: unknown;
      output?: unknown;
      metrics?: Record<string, number>;
    }>;
    const output = rows.find((row) => row.output)?.output as {
      content: { image_url: { url: unknown } }[];
    };
    if (captureAttachments)
      expect(output.content[0].image_url.url).toBeInstanceOf(Attachment);
    else expect(output.content).toEqual([]);
  },
);

it("uses the owning span for delayed Google media output", async () => {
  const local = initLogger({
    ...loggerOptions,
    setCurrent: false,
    captureAttachments: false,
  });
  let resolve!: (value: {
    generatedImages: { image: { imageBytes: string; mimeType: string } }[];
  }) => void;
  const promise = new Promise<{
    generatedImages: { image: { imageBytes: string; mimeType: string } }[];
  }>((done) => {
    resolve = done;
  });
  const pending = local.traced(() =>
    googleGenAIChannels.generateImages.invoke(
      () => promise,
      undefined,
      [{ model: "model", prompt: "draw" }],
      {},
    ),
  );
  initLogger({ ...loggerOptions, captureAttachments: true });
  const binary = vi.fn((): string => {
    throw new Error("must not read skipped media");
  });
  resolve({
    generatedImages: [
      {
        image: {
          get imageBytes() {
            return binary();
          },
          mimeType: "image/png",
        },
      },
    ],
  });
  await pending;
  expect(binary).not.toHaveBeenCalled();
  const rows = (await background.drain()) as Array<{
    input?: unknown;
    output?: unknown;
    metrics?: Record<string, number>;
  }>;
  expect(JSON.stringify(rows)).not.toContain("AQID");
  expect(JSON.stringify(rows)).not.toContain("file_data");
});

it("keeps ElevenLabs transcripts and timing without decoding or retaining audio", async () => {
  const local = initLogger({
    ...loggerOptions,
    setCurrent: false,
    captureAttachments: false,
  });
  const decode = vi.spyOn(globalThis, "atob");
  async function* audio() {
    yield { audioBase64: "AQID", alignment: { characters: ["h", "i"] } };
  }
  const span = local.startSpan();
  const stream = await withCurrent(span, () =>
    elevenLabsChannels.streamWithTimestamps.invoke(
      async () => audio(),
      undefined,
      ["voice", { text: "hi" }],
      {},
    ),
  );
  initLogger({ ...loggerOptions, captureAttachments: true });
  for await (const chunk of stream) expect(chunk.audioBase64).toBe("AQID");
  span.end();
  const rows = (await background.drain()) as Array<{
    input?: unknown;
    output?: unknown;
    metrics?: Record<string, number>;
  }>;
  expect(decode).not.toHaveBeenCalled();
  expect(JSON.stringify(rows)).not.toContain("AQID");
  expect(JSON.stringify(rows)).not.toContain("file_data");
  expect(
    rows.some((row) => row.metrics?.time_to_first_token !== undefined),
  ).toBe(true);
  expect(rows.find((row) => row.output)?.output).toMatchObject({
    content: [],
    annotations: [{ alignment: { characters: ["h", "i"] } }],
  });
});

it("does not read Groq speech blobs or retain audio when disabled", async () => {
  const local = initLogger({
    ...loggerOptions,
    setCurrent: false,
    captureAttachments: false,
  });
  const response = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "audio/wav" },
  });
  const blobRead = vi.spyOn(Blob.prototype, "arrayBuffer");
  const concatenate = vi.spyOn(byteUtils, "concatUint8Arrays");
  const result = await local.traced(() =>
    groqChannels.audioSpeechCreate.tracePromise(async () => response, {
      arguments: [{ model: "model", input: "hi", voice: "voice" }],
    }),
  );
  initLogger({ ...loggerOptions, captureAttachments: true });
  const blob = await result.blob();
  expect(blob.size).toBe(3);
  expect(blobRead).not.toHaveBeenCalled();
  expect(concatenate).not.toHaveBeenCalled();
  const rows = (await background.drain()) as Array<{ output?: unknown }>;
  expect(JSON.stringify(rows)).not.toContain("braintrust_attachment");
  expect(rows.find((row) => row.output)?.output).toEqual({ content: [] });
});

it("preserves a deferred instrumentation policy when a different logger supplies the span parent", async () => {
  initLogger({ ...loggerOptions, captureAttachments: true });
  const args = { name: "deferred", [CAPTURE_ATTACHMENTS]: false };
  const deferred = startSpan(args);
  const child = deferred.startSpan();
  expect(isAutoCaptureAttachmentsEnabled(deferred)).toBe(false);
  expect(isAutoCaptureAttachmentsEnabled(child)).toBe(false);
  child.end();
  deferred.end();
});
