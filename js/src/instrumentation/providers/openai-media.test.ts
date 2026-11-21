import { withInstrumentationContentPolicy } from "../../instrumentation-content-policy";
import { setSpanCustomizers } from "../../span-customizer";
import { extractOpenAIChatInput } from "./openai-span-data";
import { registry } from "../registry";
import { _exportsForTestingOnly as audioCodecs } from "../../audio-compression";
import { registerInstrumentation } from "../registrations/openai";
import { Readable } from "node:stream";
import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { Attachment, initLogger, withCurrent } from "../../logger/core";
import { _exportsForTestingOnly } from "../../logger/testing";
import { configureNode } from "../../node/config";
import { openAIChannels } from "./openai-interceptors";
configureNode();
registerInstrumentation();
const originalAutoCaptureAttachments =
  process.env.BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS;
let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
});
beforeEach(() => {
  process.env.BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS = "true";
  vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
  background = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({
    projectName: "tmp-luca-openai-media-tests",
    projectId: "test-project-id",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setSpanCustomizers([]);
  audioCodecs.reset();
  vi.unstubAllEnvs();
  if (originalAutoCaptureAttachments === undefined) {
    delete process.env.BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS;
  } else {
    process.env.BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS =
      originalAutoCaptureAttachments;
  }
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

it("preserves native promise identity and provider failures", async () => {
  const failure = new Error("provider failure");
  const promise = Promise.reject(failure);
  const result = openAIChannels.imagesGenerate.invoke(
    () => promise,
    undefined,
    [{ model: "future-image-model", prompt: "draw" }],
    {},
  );
  expect(result).toBe(promise);
  await expect(result).rejects.toBe(failure);
  const rows = (await background.drain()) as Array<{
    error?: string;
    output?: unknown;
    metrics?: Record<string, number>;
    metadata?: Record<string, unknown>;
    span_attributes?: { name?: string };
  }>;
  expect(rows.some((row) => row.error?.includes("provider failure"))).toBe(
    true,
  );
});

it("captures streamed transcripts, omitting invented usage and control-event TTFT", async () => {
  async function* events() {
    yield { type: "transcript.started" };
    yield { type: "transcript.text.delta", delta: "hel" };
    yield { type: "transcript.text.delta", delta: "lo" };
    yield {
      type: "transcript.text.done",
      text: "hello",
      usage: { type: "duration", seconds: 5 },
    };
  }
  const stream = events();
  const result = await openAIChannels.audioTranscriptionsCreate.invoke(
    async () => stream,
    undefined,
    [{ model: "future-transcribe-model", stream: true }],
    {},
  );
  expect(result).toBe(stream);
  for await (const _event of stream) {
    /* consume */
  }
  const rows = (await background.drain()) as Array<{
    error?: string;
    output?: unknown;
    metrics?: Record<string, number>;
    metadata?: Record<string, unknown>;
    span_attributes?: { name?: string };
  }>;
  expect(rows.find((row) => row.output)?.output).toEqual({
    content: [{ type: "text", text: "hello" }],
  });
  expect(
    rows.some((row) => row.metrics?.time_to_first_token !== undefined),
  ).toBe(true);
  expect(rows.some((row) => row.metrics?.seconds !== undefined)).toBe(false);
});

it("does not upload incomplete speech and preserves response identity", async () => {
  let pulls = 0;
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array([1, 2]));
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "audio/mpeg" } },
  );
  const value = await openAIChannels.audioSpeechCreate.invoke(
    async () => response,
    undefined,
    [{ model: "future-tts-model", input: "hello" }],
    {},
  );
  expect(value).toBe(response);
  expect(pulls).toBe(0);
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
  await reader.cancel();
  expect((await reader.read()).done).toBe(true);
  const rows = (await background.drain()) as Array<{
    error?: string;
    output?: unknown;
    metrics?: Record<string, number>;
    metadata?: Record<string, unknown>;
    span_attributes?: { name?: string };
  }>;
  expect(rows.find((row) => row.output)?.output).toEqual({ content: [] });
});

it("does not capture speech response bytes without attachment opt-in", async () => {
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "false");
  delete process.env.BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS;
  const response = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "audio/mpeg" },
  });
  const originalArrayBuffer = response.arrayBuffer;

  await openAIChannels.audioSpeechCreate.invoke(
    async () => response,
    undefined,
    [{ model: "tts", input: "hello" }],
    {},
  );

  expect(response.arrayBuffer).toBe(originalArrayBuffer);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  const rows = (await background.drain()) as Array<{ output?: unknown }>;
  expect(rows.find((row) => row.output)?.output).toEqual({ content: [] });
  expect(JSON.stringify(rows)).not.toContain("braintrust_attachment");
});

it("does not read media upload values without attachment opt-in", async () => {
  delete process.env.BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS;
  let reads = 0;
  const image = {
    name: "input.png",
    type: "image/png",
    size: 3,
    async arrayBuffer() {
      reads++;
      return new Uint8Array([1, 2, 3]).buffer;
    },
  };

  await openAIChannels.imagesEdit.invoke(
    async () => ({ data: [] }),
    undefined,
    [{ model: "image-model", image, prompt: "edit" }],
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const rows = (await background.drain()) as Array<{
    input?: { content?: Array<{ image_url?: { url?: unknown } }> };
  }>;
  expect(reads).toBe(0);
  expect(
    rows.find((row) => row.input?.content)?.input?.content?.[0]?.image_url?.url,
  ).toBe("<omitted>");
});

it("copies consumed audio before application mutations", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "audio/mpeg" },
  });
  await openAIChannels.audioSpeechCreate.invoke(
    async () => response,
    undefined,
    [{ model: "tts", input: "hello" }],
    {},
  );
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  chunk.value!.fill(99);
  await reader.read();
  const rows = (await background.drain()) as Array<{
    output?: {
      content: Array<{ file: { file_data: Attachment; byte_size: number } }>;
    };
  }>;
  const output = rows.find((row) => row.output?.content.length)?.output;
  const attachment = output!.content[0].file.file_data;
  expect(attachment).toBeInstanceOf(Attachment);
  expect(new Uint8Array(await (await attachment.data()).arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});

it("measures speech SSE TTFT from audio and emits one decoded artifact", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  await openAIChannels.audioSpeechCreate.invoke(
    async () => response,
    undefined,
    [{ model: "tts", input: "hello" }],
    {},
  );
  const reader = response.body!.getReader();
  controller.enqueue(
    new TextEncoder().encode('data: {"type":"speech.created"}\n\n'),
  );
  await reader.read();
  const early = (await background.drain()) as Array<{
    metrics?: Record<string, number>;
  }>;
  expect(
    early.some((row) => row.metrics?.time_to_first_token !== undefined),
  ).toBe(false);
  controller.enqueue(
    new TextEncoder().encode(
      'data: {"type":"speech.audio.delta","audio":"AQID"}\n\ndata: {"type":"speech.audio.done","usage":{"input_tokens":2,"output_tokens":3}}\n\n',
    ),
  );
  await reader.read();
  controller.close();
  await reader.read();
  const rows = (await background.drain()) as Array<{
    metrics?: Record<string, number>;
    output?: {
      content: Array<{ file: { file_data: Attachment; byte_size: number } }>;
    };
  }>;
  expect(
    rows.some((row) => row.metrics?.time_to_first_token !== undefined),
  ).toBe(true);
  const output = rows.find((row) => row.output?.content.length)?.output;
  expect(output!.content[0].file.byte_size).toBe(3);
  expect(
    new Uint8Array(
      await (await output!.content[0].file.file_data.data()).arrayBuffer(),
    ),
  ).toEqual(new Uint8Array([1, 2, 3]));
});

it("keeps failures from malformed instrumentation data out of the application path", async () => {
  const response = {
    get data(): never {
      throw new Error("hostile getter");
    },
  };
  expect(
    await openAIChannels.imagesGenerate.invoke(
      async () => response,
      undefined,
      [{ model: "future-image", prompt: "draw" }],
      {},
    ),
  ).toBe(response);
});

it("captures only the bytes consumed from an upload stream", async () => {
  const stream = Readable.from([Buffer.from([1, 2, 3])]);
  await openAIChannels.audioTranscriptionsCreate.invoke(
    async () => {
      for await (const _chunk of stream) {
        /* SDK upload consumption */
      }
      return { text: "hello" };
    },
    undefined,
    [{ model: "transcribe", file: stream }],
    {},
  );
  const rows = (await background.drain()) as Array<{
    input?: { content: Array<{ file: { file_data: Attachment } }> };
  }>;
  const attachment = rows.find((row) => row.input)?.input!.content[0].file
    .file_data;
  expect(attachment).toBeInstanceOf(Attachment);
  expect(
    new Uint8Array(await (await attachment!.data()).arrayBuffer()),
  ).toEqual(new Uint8Array([1, 2, 3]));
});

it.each(
  [false, true].flatMap((generic) => [
    [false, false, generic],
    [true, false, generic],
    [false, true, generic],
    [true, true, generic],
  ]),
)(
  "directional voice consent user=%s agent=%s generic=%s",
  async (user, agent, generic) => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", String(generic));
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", String(user));
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", String(agent));
    await openAIChannels.audioTranscriptionsCreate.invoke(
      async () => ({ text: "hello" }),
      undefined,
      [
        {
          model: "unit",
          file: new File(["audio"], "input.wav", { type: "audio/wav" }),
        },
      ],
      {},
    );
    const speech = await openAIChannels.audioSpeechCreate.invoke(
      async () => new Response(new Uint8Array([1, 2])),
      undefined,
      [{ model: "unit", input: "hello", response_format: "pcm" }],
      {},
    );
    await (speech as Response).arrayBuffer();
    await openAIChannels.imagesGenerate.invoke(
      async () => ({ data: [{ b64_json: "AQI=" }] }),
      undefined,
      [{ model: "image-unit", prompt: "image" }],
      {},
    );
    const rows = (await background.drain()) as any[];
    const transcription = rows.find(
      (row) =>
        row.span_attributes?.name === "openai.audio.transcriptions.create",
    );
    const synthesis = rows.find(
      (row) => row.span_attributes?.name === "openai.audio.speech.create",
    );
    const image = rows.find(
      (row) => row.span_attributes?.name === "openai.images.generate",
    );
    expect(
      transcription.input.content[0].file.file_data instanceof Attachment,
    ).toBe(user);
    expect(synthesis.output.content.length > 0).toBe(agent);
    expect(transcription.output.content).toEqual([
      { type: "text", text: "hello" },
    ]);
    expect(image.output.content[0].image_url.url instanceof Attachment).toBe(
      generic,
    );
  },
);

it("explicit logger capture opt-out wins over environment voice opt-ins", async () => {
  const logger = initLogger({
    projectName: "tmp-luca-voice-opt-out",
    projectId: "test-project-id",
    setCurrent: false,
    autoCaptureAttachments: false,
  });
  const root = logger.startSpan({ name: "parent" });
  const child = root.startSpan({ name: "child" });
  await withCurrent(child, async () => {
    const response = await openAIChannels.audioSpeechCreate.invoke(
      async () => new Response(new Uint8Array([1, 2])),
      undefined,
      [{ model: "unit", input: "hello" }],
      {},
    );
    await (response as Response).arrayBuffer();
  });
  const rows = (await background.drain()) as any[];
  expect(
    rows.find(
      (row) => row.span_attributes?.name === "openai.audio.speech.create",
    ).output,
  ).toEqual({ content: [] });
});

it("OpenAI audio opt-out retains provider spans, text and unrelated image capture", async () => {
  vi.spyOn(registry, "integrationConfig").mockReturnValue({ audio: false });
  const response = new Response(new Uint8Array([1, 2]), {
    headers: { "content-type": "audio/pcm" },
  });
  const read = response.arrayBuffer;
  await openAIChannels.audioSpeechCreate.invoke(
    async () => response,
    undefined,
    [{ model: "unit", input: "hello", response_format: "pcm" }],
    {},
  );
  expect(response.arrayBuffer).toBe(read);
  await openAIChannels.audioTranscriptionsCreate.invoke(
    async () => ({ text: "hello" }),
    undefined,
    [
      {
        model: "unit",
        file: new File(["audio"], "input.wav", { type: "audio/wav" }),
      },
    ],
    {},
  );
  await openAIChannels.imagesGenerate.invoke(
    async () => ({ data: [{ b64_json: "AQI=" }] }),
    undefined,
    [{ model: "image-unit", prompt: "image" }],
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rows = (await background.drain()) as any[];
  const speech = rows.find(
    (r) => r.span_attributes?.name === "openai.audio.speech.create",
  );
  const stt = rows.find(
    (r) => r.span_attributes?.name === "openai.audio.transcriptions.create",
  );
  const image = rows.find(
    (r) => r.span_attributes?.name === "openai.images.generate",
  );
  expect(speech.output).toEqual({ content: [] });
  expect(speech.input.prompt).toBe("hello");
  expect(stt.input.content[0].file.file_data).toBe("<omitted>");
  expect(stt.output.content).toEqual([{ type: "text", text: "hello" }]);
  expect(image.output.content[0].image_url.url).toBeInstanceOf(Attachment);
});

it("speech encoding waits for export and never delays or changes the application read", async () => {
  const key = Symbol.for("braintrust.audio");
  const globals = globalThis as Record<symbol, unknown>;
  const original = globals[key];
  let encoded = 0;
  globals[key] = {
    version: 1,
    createStack: () => [
      async (bytes: Uint8Array, meta: any, next: any) => {
        encoded++;
        return next(new Uint8Array([79, 103, 103]), {
          ...meta,
          mimeType: "audio/ogg",
          encoding: "opus",
        });
      },
    ],
  };
  audioCodecs.reset();
  try {
    const response = new Response(new Uint8Array([1, 0, 2, 0]), {
      headers: { "content-type": "audio/pcm" },
    });
    const result = await openAIChannels.audioSpeechCreate.invoke(
      async () => response,
      undefined,
      [{ model: "unit", input: "hello", response_format: "pcm" }],
      {},
    );
    expect(result).toBe(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 0, 2, 0]),
    );
    expect(encoded).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = (await background.drain()) as any[];
    const speech = rows.find(
      (r) => r.span_attributes?.name === "openai.audio.speech.create",
    );
    expect(speech.output.content[0].file).toMatchObject({
      filename: "speech.ogg",
      byte_size: 3,
    });
    expect(speech.output.content[0].file.file_data.reference.content_type).toBe(
      "audio/ogg",
    );
    expect(speech.input.parameters.format).toBe("pcm");
    expect(encoded).toBe(1);
  } finally {
    globals[key] = original;
  }
});

it("OpenAI audio opt-out also omits chat audio without removing images or transcripts", async () => {
  vi.spyOn(registry, "integrationConfig").mockReturnValue({ audio: false });
  const params = {
    model: "audio-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: "AQI=", format: "wav" } },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AQI=" },
          },
        ],
      },
    ],
  };
  const result = extractOpenAIChatInput(params).input as any[];
  expect(result[0].content[0].input_audio).not.toHaveProperty("data");
  expect(result[0].content[1].image_url.url).toBeInstanceOf(Attachment);
  expect(params.messages[0].content[0].input_audio?.data).toBe("AQI=");
  await openAIChannels.chatCompletionsCreate.invoke(
    async () => ({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            audio: { data: "AQI=", transcript: "hello", id: "a" },
          },
          finish_reason: "stop",
        },
      ],
    }),
    undefined,
    [
      {
        model: "audio-model",
        messages: [],
        audio: { voice: "alloy", format: "pcm16" },
      },
    ],
    {},
  );
  const rows = (await background.drain()) as any[];
  const output = rows.find(
    (r) => r.span_attributes?.name === "Chat Completion",
  ).output;
  expect(output[0].message.audio).toEqual({ transcript: "hello", id: "a" });
});

it("export redaction removes audio before any encoding work", async () => {
  const key = Symbol.for("braintrust.audio");
  const globals = globalThis as Record<symbol, unknown>;
  const original = globals[key];
  const createStack = vi.fn(() => {
    throw Error("must not encode redacted content");
  });
  globals[key] = { version: 1, createStack };
  audioCodecs.reset();
  setSpanCustomizers([
    {
      onSpanExport(data) {
        delete data.output;
        return data;
      },
    },
  ]);
  try {
    const response = new Response(new Uint8Array([1, 0, 2, 0]), {
      headers: { "content-type": "audio/pcm" },
    });
    await openAIChannels.audioSpeechCreate.invoke(
      async () => response,
      undefined,
      [{ model: "unit", input: "hello", response_format: "pcm" }],
      {},
    );
    await response.arrayBuffer();
    const rows = (await background.drain()) as any[];
    expect(rows.every((row) => row.output === undefined)).toBe(true);
    expect(createStack).not.toHaveBeenCalled();
  } finally {
    globals[key] = original;
  }
});

it("redaction during deferred encoding prevents the completed audio from exporting", async () => {
  const key = Symbol.for("braintrust.audio");
  const globals = globalThis as Record<symbol, unknown>;
  const original = globals[key];
  let allowed = true;
  const encode = vi.fn(async (bytes: Uint8Array, meta: any, next: any) => {
    await Promise.resolve();
    allowed = false;
    return next(bytes, { ...meta, mimeType: "audio/ogg", encoding: "opus" });
  });
  globals[key] = { version: 1, createStack: () => [encode] };
  audioCodecs.reset();
  try {
    const response = (await withInstrumentationContentPolicy(
      {
        allowed: () => allowed,
        filterFramework: (data) => data,
      },
      () =>
        openAIChannels.audioSpeechCreate.invoke(
          async () =>
            new Response(new Uint8Array([1, 0]), {
              headers: { "content-type": "audio/pcm" },
            }),
          undefined,
          [{ model: "unit", input: "hello", response_format: "pcm" }],
          {},
        ),
    )) as Response;
    await response.arrayBuffer();
    const rows = (await background.drain()) as any[];
    expect(encode).toHaveBeenCalledTimes(1);
    for (const row of rows) {
      expect(row.output?.content ?? []).toEqual([]);
      expect(row.metadata).not.toHaveProperty("contrib.audio.encodings");
    }
  } finally {
    globals[key] = original;
  }
});
