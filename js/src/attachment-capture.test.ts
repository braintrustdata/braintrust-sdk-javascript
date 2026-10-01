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
import {
  processAISDKCallInput,
  processAISDKGenerateImageInput,
  processAISDKGenerateImageOutput,
  processAISDKOutput,
  patchAISDKStreamingResult,
} from "./instrumentation/plugins/ai-sdk-plugin";
import { OpenAIAgentsTraceProcessor } from "./instrumentation/plugins/openai-agents-trace-processor";
import type { OpenAIAgentsSpan } from "./vendor-sdk-types/openai-agents";
import { googleGenerativeAIChannels } from "./instrumentation/plugins/google-generative-ai-channels";
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

it.each([false, true])(
  "processes native OpenAI media with capture=%s",
  (captureAttachments) => {
    const input = [
      {
        type: "input_image",
        image_url: "data:image/png;base64,AQID",
        detail: "low",
      },
      { type: "input_image", image: "data:image/png;base64,AQID" },
      { type: "input_file", file_data: "AQID", filename: "document.pdf" },
      { type: "input_audio", input_audio: { data: "AQID", format: "wav" } },
      { type: "input_image", image_url: "https://example.com/image.png" },
      { type: "input_file", file_id: "file-123" },
    ];
    const result = processInputAttachments(input, captureAttachments);
    expect(result).toEqual([
      {
        type: "input_image",
        detail: "low",
        ...(captureAttachments ? { image_url: expect.any(Attachment) } : {}),
      },
      ...(captureAttachments
        ? [{ type: "input_image", image: expect.any(Attachment) }]
        : []),
      {
        type: "input_file",
        filename: "document.pdf",
        ...(captureAttachments ? { file_data: expect.any(Attachment) } : {}),
      },
      {
        type: "input_audio",
        input_audio: {
          format: "wav",
          ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
        },
      },
      ...input.slice(4),
    ]);
    expect(input[2].file_data).toBe("AQID");
  },
);

it.each([false, true])(
  "applies the owning policy to AI SDK tool-result media (%s)",
  async (captureAttachments) => {
    initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
    const local = initLogger({
      ...loggerOptions,
      setCurrent: false,
      captureAttachments,
    });
    const media = ["image-data", "file-data", "media"].map((type) => ({
      type,
      data: "AQID",
      mediaType: "image/png",
    }));
    const references = [
      { type: "text", text: "Screenshot captured" },
      { type: "image-url", url: "https://example.com/image.png" },
      { type: "file-id", fileId: "file-123" },
    ];
    const toolResult = {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "screenshot",
      output: { type: "content", value: [...media, ...references] },
    };
    const messages = [{ role: "tool", content: [toolResult] }];
    const decode = vi.spyOn(globalThis, "atob");
    await local.traced(() => {
      const input = processAISDKCallInput({
        model: { modelId: "model", provider: "test" },
        messages,
      }).input;
      const output = processAISDKOutput({ response: { messages } }, []);
      const expected = [
        ...media.map(({ data: _data, ...part }) => ({
          ...part,
          ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
        })),
        ...references,
      ];
      expect(input).toHaveProperty(
        "messages.0.content.0.output.value",
        expected,
      );
      expect(output).toHaveProperty(
        "response.messages.0.content.0.output.value",
        expected,
      );
    });
    if (!captureAttachments) expect(decode).not.toHaveBeenCalled();
    expect(toolResult.output.value).toEqual([...media, ...references]);
    expect(media.every((part) => part.data === "AQID")).toBe(true);
  },
);

it.each([false, true])(
  "processes AI SDK media throughout output containers with capture=%s",
  (captureAttachments) => {
    initLogger({ ...loggerOptions, captureAttachments });
    const readBytes = vi.fn(() => "AQID");
    const generatedFile = {
      mediaType: "image/png",
      get base64() {
        return readBytes();
      },
    };
    const file = { type: "file", file: generatedFile };
    const message = {
      role: "assistant",
      content: [
        { type: "file", mediaType: "image/png", data: "AQID" },
        { type: "text", text: "Done" },
      ],
    };
    const result = processAISDKOutput(
      {
        content: [file],
        steps: [{ content: [file], response: { messages: [message] } }],
        response: {
          messages: [message],
          timestamp: new Date("2026-09-28T00:00:00Z"),
        },
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      [],
    );
    expect(result).toHaveProperty(
      "content",
      captureAttachments
        ? [{ type: "file", file: expect.any(Attachment) }]
        : [],
    );
    expect(result).toHaveProperty(
      "steps.0.content",
      captureAttachments
        ? [{ type: "file", file: expect.any(Attachment) }]
        : [],
    );
    for (const path of [
      "response.messages.0.content",
      "steps.0.response.messages.0.content",
    ]) {
      expect(result).toHaveProperty(path, [
        {
          type: "file",
          mediaType: "image/png",
          ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
        },
        { type: "text", text: "Done" },
      ]);
    }
    expect(result).toHaveProperty("usage", { inputTokens: 1, outputTokens: 2 });
    expect(result).toHaveProperty(
      "response.timestamp",
      "2026-09-28T00:00:00.000Z",
    );
    if (!captureAttachments) expect(readBytes).not.toHaveBeenCalled();
    expect(message.content[0].data).toBe("AQID");
  },
);

it.each([false, true])(
  "uses the active Agents processor's owning policy (%s)",
  async (captureAttachments) => {
    const logger = initLogger({
      ...loggerOptions,
      setCurrent: false,
      captureAttachments,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const trace = {
      type: "trace" as const,
      traceId: "media-trace",
      name: "media trace",
      groupId: null,
    };
    const span: OpenAIAgentsSpan = {
      type: "trace.span",
      traceId: trace.traceId,
      spanId: "media-span",
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: {
        type: "response",
        _input: [
          { type: "input_image", image: "data:image/png;base64,AQID" },
          { type: "input_file", file: "data:application/pdf;base64,AQID" },
          { type: "input_file", file: "https://example.com/report.pdf" },
          { type: "input_file", file: { id: "file-123" } },
          {
            type: "input_file",
            file: { url: "https://example.com/report.pdf" },
          },
        ],
        _response: {
          output: [{ type: "image_generation_call", result: "AQID" }],
        },
      },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
    await processor.onSpanEnd(span);
    const rows = await background.drain();
    const output = rows.find(
      (row) => "output" in row && row.output !== undefined,
    );
    expect(output).toHaveProperty(
      "output",
      captureAttachments
        ? [{ type: "image_generation_call", result: expect.any(Attachment) }]
        : [],
    );
    expect(output).toHaveProperty("input", [
      ...(captureAttachments
        ? [
            { type: "input_image", image: expect.any(Attachment) },
            { type: "input_file", file: expect.any(Attachment) },
          ]
        : []),
      { type: "input_file", file: "https://example.com/report.pdf" },
      { type: "input_file", file: { id: "file-123" } },
      { type: "input_file", file: { url: "https://example.com/report.pdf" } },
    ]);
    expect(
      processor._traceSpans.get(trace.traceId)?.metadata.lastOutput,
    ).toEqual(output && "output" in output ? output.output : undefined);
  },
);

it.each([false, true])(
  "keeps AI SDK streamed media on its owning policy (%s)",
  async (captureAttachments) => {
    const local = initLogger({
      ...loggerOptions,
      setCurrent: false,
      captureAttachments,
    });
    const span = local.startSpan({ name: "streamed media" });
    const part = {
      type: "file",
      data: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    };
    const result = {
      fullStream: (async function* () {
        yield part;
      })(),
      content: [part],
      text: "Done",
    };
    expect(
      patchAISDKStreamingResult({
        defaultDenyOutputPaths: [],
        endEvent: {},
        result,
        span,
        startTime: Date.now() / 1000,
      }),
    ).toBe(true);
    initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
    for await (const chunk of result.fullStream) expect(chunk).toBe(part);
    const rows = await background.drain();
    expect(rows.find((row) => "output" in row)).toHaveProperty("output", {
      content: [
        {
          type: "file",
          mediaType: "image/png",
          ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
        },
      ],
      text: "Done",
    });
    expect(part.data).toEqual(new Uint8Array([1, 2, 3]));
  },
);

it.each([false, true])(
  "applies the active Agents policy to speech and transcription (%s)",
  async (captureAttachments) => {
    const local = initLogger({
      ...loggerOptions,
      setCurrent: false,
      captureAttachments,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger: local });
    const trace = {
      type: "trace" as const,
      traceId: "audio-trace",
      name: "audio trace",
      groupId: null,
    };
    await processor.onTraceStart(trace);
    for (const type of ["speech", "transcription"] as const) {
      const audio = { data: "AQID", format: "pcm" };
      const span: OpenAIAgentsSpan = {
        type: "trace.span",
        traceId: trace.traceId,
        spanId: type,
        parentId: null,
        startedAt: null,
        endedAt: null,
        error: null,
        spanData:
          type === "speech"
            ? { type, input: "Hello", output: audio }
            : { type, input: audio, output: "Hello" },
      };
      await processor.onSpanStart(span);
      initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
      await processor.onSpanEnd(span);
      const payload = (await background.drain()).find((row) => "output" in row);
      expect(payload).toHaveProperty(type === "speech" ? "output" : "input", {
        format: "pcm",
        ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
      });
      expect(audio.data).toBe("AQID");
    }
  },
);

it.each([false, true])(
  "keeps deferred Google chat input on its owning policy (%s)",
  async (captureAttachments) => {
    initLogger({ ...loggerOptions, captureAttachments });
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = googleGenerativeAIChannels.sendMessage.invoke(
      async () => {
        await queued;
        return { response: {} };
      },
      { model: "models/test", _history: [], _sendPromise: queued },
      [[{ inlineData: { mimeType: "image/png", data: "AQID" } }]],
      {},
    );
    initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
    release();
    await pending;
    const inputs = (await background.drain()).filter((row) => "input" in row);
    expect(inputs.length).toBeGreaterThan(0);
    for (const row of inputs) {
      if (captureAttachments)
        expect(row).toHaveProperty(
          "input.contents.0.parts.0.inlineData.data",
          expect.any(Attachment),
        );
      else
        expect(row).not.toHaveProperty(
          "input.contents.0.parts.0.inlineData.data",
        );
    }
  },
);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "applies capture=%s to AI SDK image-edit inputs and masks (URL object: %s)",
  async (captureAttachments, maskAsURL) => {
    initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
    const local = initLogger({
      ...loggerOptions,
      setCurrent: false,
      captureAttachments,
    });
    const data = new URL("data:image/png;base64,AQID");
    const remote = new URL("https://example.com/image.png");
    const manual = new Attachment({
      data: "manual",
      filename: "manual.png",
      contentType: "image/png",
    });
    const prompt = {
      images: [
        "AQID",
        new Uint8Array([1, 2, 3]),
        data,
        remote,
        remote.href,
        manual,
      ],
      mask: maskAsURL ? data : data.href,
      text: "Edit these images",
    };
    const decode = vi.spyOn(globalThis, "atob");
    const result = await local.traced(() =>
      processAISDKGenerateImageInput({
        model: { modelId: "image-model", provider: "test" },
        prompt,
      }),
    );
    expect(result.input).toHaveProperty(
      "prompt",
      captureAttachments
        ? {
            images: [
              expect.any(Attachment),
              expect.any(Attachment),
              expect.any(Attachment),
              remote,
              remote.href,
              manual,
            ],
            mask: expect.any(Attachment),
            text: prompt.text,
          }
        : { images: [remote, remote.href, manual], text: prompt.text },
    );
    if (!captureAttachments) expect(decode).not.toHaveBeenCalled();
    expect(prompt.images).toHaveLength(6);
    expect(prompt.mask).toBe(maskAsURL ? data : data.href);
  },
);

it("preserves AI SDK image-edit inputs when conversion fails", () => {
  initLogger({ ...loggerOptions, captureAttachments: true });
  const prompt = {
    images: ["not valid base64!"],
    mask: "not valid base64!",
    text: "Edit",
  };
  const result = processAISDKGenerateImageInput({
    model: { modelId: "model", provider: "test" },
    prompt,
  });
  expect(result.input).toHaveProperty("prompt", prompt);
});

it.each([false, true])(
  "applies capture=%s to AI SDK content parts containing data URL objects",
  (captureAttachments) => {
    initLogger({ ...loggerOptions, captureAttachments });
    const data = new URL("data:image/png;base64,AQID");
    const content = [
      { type: "image", image: data },
      { type: "file", data, mediaType: "image/png" },
      { type: "image_url", image_url: { url: data } },
    ];
    const result = processAISDKCallInput({
      model: { modelId: "model", provider: "test" },
      messages: [{ role: "user", content }],
    });
    expect(result.input).toHaveProperty("messages", [
      {
        role: "user",
        content: captureAttachments
          ? [
              { type: "image", image: expect.any(Attachment) },
              {
                type: "file",
                data: expect.any(Attachment),
                mediaType: "image/png",
              },
              { type: "image_url", image_url: { url: expect.any(Attachment) } },
            ]
          : [{ type: "file", mediaType: "image/png" }],
      },
    ]);
  },
);

it.each(["transcription", "translation"])(
  "does not expose Groq %s data URLs through filenames",
  async (operation) => {
    const local = initLogger({
      ...loggerOptions,
      setCurrent: false,
      captureAttachments: false,
    });
    const data = "data:audio/wav;base64,AQID/BAUG";
    const decode = vi.spyOn(globalThis, "atob");
    const channel =
      operation === "transcription"
        ? groqChannels.audioTranscriptionsCreate
        : groqChannels.audioTranslationsCreate;
    await local.traced(() =>
      channel.tracePromise(async () => ({ text: "hi" }), {
        arguments: [{ model: "model", file: data }],
      }),
    );
    const rows = await background.drain();
    const inputs = rows.map((row) => ("input" in row ? row.input : undefined));
    expect(inputs.find(Boolean)).toMatchObject({
      content: [{ type: "file", file: { filename: "audio" } }],
    });
    expect(JSON.stringify(rows)).not.toContain("BAUG");
    expect(decode).not.toHaveBeenCalled();
  },
);

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

it.each([false, true])(
  "preserves AI SDK application JSON that resembles media (capture=%s)",
  async (captureAttachments) => {
    const logger = initLogger({ ...loggerOptions, captureAttachments });
    const object = { type: "file", data: "report text" };
    const toolCall = {
      type: "tool-call",
      toolCallId: "call",
      toolName: "report",
      input: object,
      args: object,
    };
    const toolResult = {
      type: "tool-result",
      toolCallId: "call",
      toolName: "report",
      input: object,
      output: { type: "json", value: object },
      result: object,
    };
    const messages = [
      { role: "assistant", content: [toolCall] },
      { role: "tool", content: [toolResult] },
    ];
    const result = {
      object,
      output: object,
      content: [toolCall, toolResult],
      toolCalls: [toolCall],
      toolResults: [toolResult],
      response: { messages },
      steps: [{ content: [toolCall, toolResult], providerMetadata: object }],
      providerMetadata: object,
    };
    expect(processAISDKOutput(result, [], captureAttachments)).toEqual(result);
    expect(
      processAISDKCallInput({
        model: { modelId: "test", provider: "test" },
        messages,
      }).input,
    ).toHaveProperty("messages", messages);

    const span = logger.startSpan({ name: "structured stream" });
    const streamResult = {
      partialObjectStream: (async function* () {
        yield object;
      })(),
      object: Promise.resolve(object),
    };
    expect(
      patchAISDKStreamingResult({
        defaultDenyOutputPaths: [],
        endEvent: {},
        result: streamResult,
        span,
        startTime: Date.now() / 1000,
      }),
    ).toBe(true);
    for await (const chunk of streamResult.partialObjectStream)
      expect(chunk).toEqual(object);
    const rows = await background.drain();
    expect(rows.find((row) => "output" in row)).toHaveProperty(
      "output.object",
      object,
    );
  },
);

it.each([false, true])(
  "captures Agents audio output using the owning policy (%s)",
  async (captureAttachments) => {
    const logger = initLogger({
      ...loggerOptions,
      captureAttachments,
      setCurrent: false,
    });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const trace = {
      type: "trace" as const,
      traceId: "audio-output",
      name: "audio output",
      groupId: null,
    };
    const audio = {
      data: "AQID",
      transcript: "Hello",
      id: "audio-1",
      expires_at: 123,
    };
    const output = [{ choices: [{ message: { role: "assistant", audio } }] }];
    const span: OpenAIAgentsSpan = {
      type: "trace.span",
      traceId: trace.traceId,
      spanId: "generation",
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: { type: "generation", output },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    initLogger({ ...loggerOptions, captureAttachments: !captureAttachments });
    await processor.onSpanEnd(span);
    const rows = await background.drain();
    const row = rows.find((row) => "output" in row && row.output !== undefined);
    expect(row).toHaveProperty("output.0.choices.0.message.audio", {
      transcript: "Hello",
      id: "audio-1",
      expires_at: 123,
      ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
    });
    expect(audio.data).toBe("AQID");
    const protocolAudio = {
      type: "audio",
      audio: "AQID",
      format: "mp3",
      transcript: "Hello",
    };
    expect(processInputAttachments(protocolAudio, captureAttachments)).toEqual({
      type: "audio",
      format: "mp3",
      transcript: "Hello",
      ...(captureAttachments ? { audio: expect.any(Attachment) } : {}),
    });
    const remoteAudio = { type: "audio", audio: { id: "file-123" } };
    expect(processInputAttachments(remoteAudio, captureAttachments)).toEqual(
      remoteAudio,
    );
  },
);

it.each([false, true])(
  "preserves custom Agents JSON without mutating SDK span data (%s)",
  async (captureAttachments) => {
    const logger = initLogger({ ...loggerOptions, captureAttachments });
    const processor = new OpenAIAgentsTraceProcessor({ logger });
    const trace = {
      type: "trace" as const,
      traceId: "custom-json",
      name: "custom JSON",
      groupId: null,
    };
    const data = Object.freeze({
      input: Object.freeze({ type: "file", data: "report text" }),
      output: Object.freeze({
        type: "image_generation_call",
        result: "ordinary result",
      }),
    });
    const span: OpenAIAgentsSpan = {
      type: "trace.span",
      traceId: trace.traceId,
      spanId: "custom",
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: { type: "custom", name: "report", data },
    };
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    await processor.onSpanEnd(span);
    const rows = await background.drain();
    expect(
      rows.find((row) => "output" in row && row.output !== undefined),
    ).toMatchObject(data);
    expect(span.spanData).toHaveProperty("data", data);
  },
);

it.each([false, true])(
  "applies capture policy to Chat Completions audio (%s)",
  async (captureAttachments) => {
    initLogger({ ...loggerOptions, captureAttachments });
    const audio = { data: "AQID", transcript: "Hello", id: "audio-1" };
    const result = {
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content: null, audio },
          finish_reason: "stop",
        },
      ],
    };
    await openAIChannels.chatCompletionsCreate.tracePromise(
      async () => result,
      {
        arguments: [{ model: "audio-model", messages: [] }],
      },
    );
    const rows = await background.drain();
    expect(rows.find((row) => "output" in row)).toHaveProperty(
      "output.0.message.audio",
      {
        transcript: "Hello",
        id: "audio-1",
        ...(captureAttachments ? { data: expect.any(Attachment) } : {}),
      },
    );
    expect(audio.data).toBe("AQID");
  },
);

it.each([false, true])(
  "handles raw base64 chat files without changing references (capture=%s)",
  async (captureAttachments) => {
    initLogger({ ...loggerOptions, captureAttachments });
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { file_data: "AQID", filename: "document.pdf" },
          },
          { type: "file", file: { file_id: "file-123" } },
          {
            type: "file",
            file: { file_data: "https://example.com/document.pdf" },
          },
          { type: "text", text: "Summarize this document." },
        ],
      },
    ];
    await openAIChannels.chatCompletionsCreate.tracePromise(
      async () => ({ choices: [] }),
      { arguments: [{ model: "model", messages }] },
    );
    const rows = await background.drain();
    expect(rows.find((row) => "input" in row)).toHaveProperty("input", [
      {
        role: "user",
        content: [
          {
            type: "file",
            file: {
              filename: "document.pdf",
              ...(captureAttachments
                ? { file_data: expect.any(Attachment) }
                : {}),
            },
          },
          ...messages[0].content.slice(1),
        ],
      },
    ]);
    expect(messages[0].content[0].file?.file_data).toBe("AQID");
    if (!captureAttachments) expect(JSON.stringify(rows)).not.toContain("AQID");
  },
);

it.each([false, true])(
  "preserves parsed OpenAI output and tool arguments that resemble media (capture=%s)",
  async (captureAttachments) => {
    initLogger({ ...loggerOptions, captureAttachments });
    const parsed = { type: "file", data: "report text" };
    const parsedArguments = {
      type: "input_image",
      image_url: "ordinary input",
    };
    const choices = [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          parsed,
          tool_calls: [
            {
              type: "function",
              id: "call-1",
              function: {
                name: "report",
                arguments: JSON.stringify(parsedArguments),
                parsed_arguments: parsedArguments,
              },
            },
          ],
        },
      },
    ];
    for (const channel of [
      openAIChannels.chatCompletionsCreate,
      openAIChannels.betaChatCompletionsParse,
    ]) {
      await channel.tracePromise(async () => ({ choices }), {
        arguments: [{ model: "model", messages: [] }],
      });
      const rows = await background.drain();
      expect(rows.find((row) => "output" in row)).toHaveProperty(
        "output",
        choices,
      );
    }
    expect(choices[0].message.parsed).toBe(parsed);
    expect(choices[0].message.tool_calls[0].function.parsed_arguments).toBe(
      parsedArguments,
    );
  },
);

it.each([
  ["mp3", "audio/mpeg", "mp3"],
  ["wav", "audio/wav", "wav"],
  ["flac", "audio/flac", "flac"],
  ["aac", "audio/aac", "aac"],
  ["opus", "audio/ogg", "ogg"],
  ["pcm16", "audio/pcm", "pcm"],
] as const)(
  "uses the requested %s format for generated chat audio",
  async (format, contentType, extension) => {
    initLogger({ ...loggerOptions, captureAttachments: true });
    const audio = { data: "AQID", transcript: "Hello", id: "audio-1" };
    const choices = [
      { index: 0, message: { role: "assistant", content: null, audio } },
    ];
    for (const channel of [
      openAIChannels.chatCompletionsCreate,
      openAIChannels.betaChatCompletionsParse,
    ]) {
      await channel.tracePromise(async () => ({ choices }), {
        arguments: [
          {
            model: "audio-model",
            messages: [],
            audio: { format, voice: "alloy" },
          },
        ],
      });
      const rows = await background.drain();
      expect(rows.find((row) => "output" in row)).toHaveProperty(
        "output.0.message.audio",
        {
          transcript: "Hello",
          id: "audio-1",
          data: expect.objectContaining({
            reference: expect.objectContaining({
              content_type: contentType,
              filename: `audio.${extension}`,
            }),
          }),
        },
      );
    }
    expect(audio).toEqual({ data: "AQID", transcript: "Hello", id: "audio-1" });
  },
);
