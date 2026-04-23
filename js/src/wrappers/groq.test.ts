import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { configureNode } from "../node/config";
import { _exportsForTestingOnly, initLogger } from "../logger";
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

  test("wraps chat completions and embeddings", async () => {
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
    for await (const _chunk of streamed) {
      // Consume the stream so chunk aggregation runs.
    }

    await wrapped.embeddings.create({
      input: "braintrust tracing",
      model: "nomic-embed-text-v1_5",
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(3);

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
  });
});
