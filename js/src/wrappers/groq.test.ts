import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { Readable } from "node:stream";
import { configureNode } from "../node/config";
import { Attachment, _exportsForTestingOnly, initLogger } from "../logger";
import { wrapGroq } from "./groq";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("groq wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectId: "test-project-id",
      projectName: "groq.test.ts",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  test("returns original object for unsupported clients", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = { foo: "bar" };

    expect(wrapGroq(invalid)).toBe(invalid);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Groq library. Not wrapping.",
    );
  });

  test("wraps chat completions, embeddings, and audio", async () => {
    async function* stream() {
      yield {
        choices: [{ delta: { role: "assistant" }, finish_reason: null }],
      };
      yield {
        choices: [
          {
            delta: { content: "STREAM" },
            finish_reason: "stop",
          },
        ],
        usage: {
          completion_tokens: 1,
          prompt_tokens: 4,
          total_tokens: 5,
        },
      };
    }

    const wrapped = wrapGroq({
      audio: {
        speech: {
          create: vi.fn(async (_request: Record<string, unknown>) =>
            Promise.resolve(
              new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "audio/wav" },
              }),
            ),
          ),
        },
        transcriptions: {
          create: vi.fn(async (_request: Record<string, unknown>) => ({
            duration: 1.5,
            language: "en",
            segments: [{ text: "Hello from Braintrust." }],
            text: "Hello from Braintrust.",
            words: [{ word: "Hello" }],
          })),
        },
        translations: {
          create: vi.fn(
            async (_request: Record<string, unknown>) =>
              "Hello from Braintrust.",
          ),
        },
      },
      chat: {
        completions: {
          create: vi.fn(async (request: Record<string, unknown>) => {
            if (request.stream) {
              return stream();
            }

            return {
              choices: [
                {
                  index: 0,
                  message: {
                    content: "OK",
                    role: "assistant",
                  },
                },
              ],
              usage: {
                completion_tokens: 2,
                prompt_tokens: 5,
                total_tokens: 7,
              },
              x_groq: {
                usage: {
                  dram_cached_tokens: 1,
                  sram_cached_tokens: 2,
                },
              },
            };
          }),
        },
      },
      embeddings: {
        create: vi.fn(async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: {
            prompt_tokens: 3,
            total_tokens: 3,
          },
        })),
      },
      withOptions(options: unknown) {
        return options ? this : null;
      },
    });

    expect(wrapped.withOptions({})).toBe(wrapped);

    await wrapped.chat.completions.create({
      max_completion_tokens: 12,
      messages: [{ content: "Reply with exactly OK.", role: "user" }],
      model: "llama-3.3-70b-versatile",
      temperature: 0,
    });

    const streamed = await wrapped.chat.completions.create({
      messages: [{ content: "Reply with exactly STREAM.", role: "user" }],
      model: "llama-3.3-70b-versatile",
      stream: true,
    });
    for await (const _chunk of streamed as any) {
      // Consume the stream so chunk aggregation runs.
    }

    await (wrapped.embeddings.create as any)({
      input: "braintrust tracing",
      model: "nomic-embed-text-v1_5",
    });

    const audioFile = new File([new Uint8Array([1, 2, 3])], "input.wav", {
      type: "audio/wav",
    });
    const speechResponse = await wrapped.audio.speech.create({
      input: "Hello from Braintrust.",
      model: "playai-tts",
      response_format: "wav",
      speed: 1.25,
      voice: "Fritz-PlayAI",
    });
    expect(new Uint8Array(await speechResponse.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await wrapped.audio.transcriptions.create({
      file: audioFile,
      language: "en",
      model: "whisper-large-v3-turbo",
      prompt: "Braintrust",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
    });
    await wrapped.audio.translations.create({
      file: audioFile,
      model: "whisper-large-v3-turbo",
      response_format: "json",
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(6);

    const chatSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "groq.chat.completions.create" &&
        span.output?.[0]?.message?.content === "OK",
    ) as Record<string, any> | undefined;
    const streamSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "groq.chat.completions.create" &&
        span.output?.[0]?.message?.content === "STREAM",
    ) as Record<string, any> | undefined;
    const embeddingSpan = spans.find(
      (span: any) => span.span_attributes?.name === "groq.embeddings.create",
    ) as Record<string, any> | undefined;
    const speechSpan = spans.find(
      (span: any) => span.span_attributes?.name === "groq.audio.speech.create",
    ) as Record<string, any> | undefined;
    const transcriptionSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "groq.audio.transcriptions.create",
    ) as Record<string, any> | undefined;
    const translationSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "groq.audio.translations.create",
    ) as Record<string, any> | undefined;

    expect(chatSpan?.metadata).toMatchObject({
      model: "llama-3.3-70b-versatile",
      provider: "groq",
      temperature: 0,
    });
    expect(chatSpan?.metrics).toMatchObject({
      completion_tokens: 2,
      dram_cached_tokens: 1,
      prompt_tokens: 5,
      sram_cached_tokens: 2,
      time_to_first_token: expect.any(Number),
      tokens: 7,
    });

    expect(streamSpan?.metrics).toMatchObject({
      completion_tokens: 1,
      prompt_tokens: 4,
      time_to_first_token: expect.any(Number),
      tokens: 5,
    });

    expect(embeddingSpan?.metadata).toMatchObject({
      model: "nomic-embed-text-v1_5",
      provider: "groq",
    });
    expect(embeddingSpan?.output).toEqual({
      embedding_length: 3,
    });

    expect(speechSpan).toMatchObject({
      input: {
        operation: "speech",
        parameters: {
          format: "wav",
          speed: 1.25,
          voice: "Fritz-PlayAI",
        },
        prompt: "Hello from Braintrust.",
      },
      metadata: {
        model: "playai-tts",
        provider: "groq",
      },
      output: {
        content: [
          {
            file: {
              byte_size: 3,
              file_data: expect.any(Attachment),
              filename: "speech.wav",
            },
            type: "file",
          },
        ],
      },
    });
    expect(speechSpan?.metrics).toMatchObject({
      time_to_first_token: expect.any(Number),
    });

    expect(transcriptionSpan).toMatchObject({
      input: {
        content: [
          {
            file: {
              file_data: expect.any(Attachment),
              filename: "input.wav",
            },
            type: "file",
          },
        ],
        operation: "transcribe",
        parameters: {
          format: "verbose_json",
          language: "en",
          timestamp_granularities: ["word", "segment"],
        },
        prompt: "Braintrust",
      },
      metadata: {
        model: "whisper-large-v3-turbo",
        provider: "groq",
      },
      output: {
        annotations: {
          duration: 1.5,
          language: "en",
          segments: [{ text: "Hello from Braintrust." }],
          words: [{ word: "Hello" }],
        },
        content: [{ text: "Hello from Braintrust.", type: "text" }],
      },
    });

    expect(translationSpan).toMatchObject({
      input: {
        content: [
          {
            file: {
              file_data: expect.any(Attachment),
              filename: "input.wav",
            },
            type: "file",
          },
        ],
        operation: "translate",
        parameters: { format: "json" },
      },
      metadata: {
        model: "whisper-large-v3-turbo",
        provider: "groq",
      },
      output: {
        content: [{ text: "Hello from Braintrust.", type: "text" }],
      },
    });
  });

  test("captures Response and Readable transcription inputs from consumed bytes", async () => {
    const create = vi.fn(
      async (request: {
        file: Response | Readable;
        [key: string]: unknown;
      }) => {
        if (request.file instanceof Response) await request.file.blob();
        else for await (const _chunk of request.file) void _chunk;
        return { text: "Hello from Braintrust." };
      },
    );
    const wrapped = wrapGroq({
      audio: { transcriptions: { create } },
    });
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-disposition": 'attachment; filename="response.wav"',
        "content-type": "audio/wav",
      },
    });
    const stream = Readable.from([Buffer.from([4, 5]), Buffer.from([6])]);
    Object.defineProperty(stream, "path", { value: "/tmp/stream.wav" });

    await wrapped.audio.transcriptions.create({
      file: response,
      model: "whisper-large-v3-turbo",
    });
    await wrapped.audio.transcriptions.create({
      file: stream,
      model: "whisper-large-v3-turbo",
    });

    const spans = (await backgroundLogger.drain()) as Record<string, any>[];
    const inputs = spans
      .filter(
        (span) =>
          span.span_attributes?.name === "groq.audio.transcriptions.create",
      )
      .map((span) => span.input);
    const responseAttachment = inputs.find(
      (input) => input.content?.[0]?.file?.filename === "response.wav",
    ).content[0].file.file_data as Attachment;
    const streamAttachment = inputs.find(
      (input) => input.content?.[0]?.file?.filename === "stream.wav",
    ).content[0].file.file_data as Attachment;

    expect(
      new Uint8Array(await (await responseAttachment.data()).arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(
      new Uint8Array(await (await streamAttachment.data()).arrayBuffer()),
    ).toEqual(new Uint8Array([4, 5, 6]));
  });

  test("ends speech spans when the response body is not consumed", async () => {
    const wrapped = wrapGroq({
      audio: {
        speech: {
          create: vi.fn(async (_request: Record<string, unknown>) =>
            Promise.resolve(
              new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "audio/wav" },
              }),
            ),
          ),
        },
      },
    });

    const response = await wrapped.audio.speech.create({
      input: "Hello from Braintrust.",
      model: "playai-tts",
      voice: "Fritz-PlayAI",
    });
    expect(response.bodyUsed).toBe(false);
    await Promise.resolve();

    const spans = (await backgroundLogger.drain()) as Record<string, any>[];
    const speechSpan = spans.find(
      (span) => span.span_attributes?.name === "groq.audio.speech.create",
    )!;
    expect(speechSpan).toMatchObject({
      metrics: { end: expect.any(Number) },
      output: { content: [] },
    });
  });

  test("captures speech consumed through a cloned response", async () => {
    const wrapped = wrapGroq({
      audio: {
        speech: {
          create: vi.fn(async (_request: Record<string, unknown>) =>
            Promise.resolve(
              new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "audio/wav" },
              }),
            ),
          ),
        },
      },
    });

    const response = await wrapped.audio.speech.create({
      input: "Hello from Braintrust.",
      model: "playai-tts",
      voice: "Fritz-PlayAI",
    });
    expect(new Uint8Array(await response.clone().arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(response.bodyUsed).toBe(false);

    const spans = (await backgroundLogger.drain()) as Record<string, any>[];
    const speechSpan = spans.find(
      (span) => span.span_attributes?.name === "groq.audio.speech.create",
    )!;
    const attachment = speechSpan.output.content[0].file
      .file_data as Attachment;
    expect(
      new Uint8Array(await (await attachment.data()).arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
});
