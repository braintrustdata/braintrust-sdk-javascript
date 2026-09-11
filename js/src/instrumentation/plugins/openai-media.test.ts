import { Readable } from "node:stream";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { Attachment, _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { openAIChannels } from "./openai-channels";
configureNode();
let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
});
beforeEach(() => {
  background = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({
    projectName: "tmp-luca-openai-media-tests",
    projectId: "test-project-id",
  });
});
afterEach(() => {
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
