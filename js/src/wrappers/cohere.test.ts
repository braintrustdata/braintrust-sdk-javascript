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
import { wrapCohere } from "./cohere";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("cohere wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "cohere.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  test("returns original object for unsupported clients", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = { foo: "bar" };

    expect(wrapCohere(invalid)).toBe(invalid);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Cohere library. Not wrapping.",
    );
  });

  test("wraps chat and emits a span", async () => {
    const client = wrapCohere({
      chat: vi.fn(async () => ({
        finishReason: "COMPLETE",
        id: "resp_chat",
        meta: {
          tokens: {
            inputTokens: 8,
            outputTokens: 2,
          },
        },
        text: "OK",
      })),
    });

    await client.chat({
      message: "Reply with exactly OK.",
      model: "command-r",
      temperature: 0,
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as Record<string, any>;
    expect(span.span_attributes).toMatchObject({
      name: "cohere.chat",
      type: "llm",
    });
    expect(span.metadata).toMatchObject({
      provider: "cohere",
      model: "command-r",
      temperature: 0,
    });
    expect(span.output).toBe("OK");
    expect(span.metrics).toMatchObject({
      completion_tokens: 2,
      prompt_tokens: 8,
      tokens: 10,
      time_to_first_token: expect.any(Number),
    });
  });

  test("wraps chatStream and aggregates chunks", async () => {
    async function* stream() {
      yield {
        eventType: "text-generation",
        text: "Hello",
      };
      yield {
        eventType: "stream-end",
        response: {
          finishReason: "COMPLETE",
          id: "resp_stream",
          meta: {
            tokens: {
              inputTokens: 7,
              outputTokens: 3,
            },
          },
          text: "Hello world",
        },
      };
    }

    const client = wrapCohere({
      chatStream: vi.fn(async () => stream()),
    });

    const chunks: unknown[] = [];
    const result = await client.chatStream({
      message: "Say hello",
      model: "command-r",
    });

    for await (const chunk of result) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as Record<string, any>;
    expect(span.span_attributes).toMatchObject({
      name: "cohere.chatStream",
      type: "llm",
    });
    expect(span.output).toBe("Hello world");
    expect(span.metrics).toMatchObject({
      completion_tokens: 3,
      prompt_tokens: 7,
      tokens: 10,
    });
  });

  test("wraps embed and rerank", async () => {
    const client = wrapCohere({
      embed: vi.fn(async () => ({
        embeddings: {
          float: [[0.1, 0.2, 0.3]],
        },
        id: "embed_1",
        meta: {
          tokens: {
            inputTokens: 4,
          },
        },
      })),
      rerank: vi.fn(async () => ({
        id: "rerank_1",
        meta: {
          billedUnits: {
            searchUnits: 1,
          },
        },
        results: [
          {
            index: 0,
            relevanceScore: 0.99,
          },
        ],
      })),
    });

    await client.embed({
      inputType: "search_document",
      model: "embed-v4.0",
      texts: ["braintrust tracing"],
    });

    await client.rerank({
      documents: ["Paris is in France", "Vienna is in Austria"],
      model: "rerank-v3.5",
      query: "capital of france",
      topN: 1,
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);

    const embedSpan = spans.find(
      (span: any) => span.span_attributes?.name === "cohere.embed",
    ) as Record<string, any> | undefined;
    const rerankSpan = spans.find(
      (span: any) => span.span_attributes?.name === "cohere.rerank",
    ) as Record<string, any> | undefined;

    expect(embedSpan).toBeDefined();
    expect(embedSpan?.metadata).toMatchObject({
      provider: "cohere",
      model: "embed-v4.0",
      inputType: "search_document",
    });
    expect(embedSpan?.output).toEqual({
      embedding_length: 3,
    });

    expect(rerankSpan).toBeDefined();
    expect(rerankSpan?.metadata).toMatchObject({
      provider: "cohere",
      model: "rerank-v3.5",
      topN: 1,
      document_count: 2,
    });
    expect(rerankSpan?.output).toEqual([
      {
        index: 0,
        relevance_score: 0.99,
      },
    ]);
  });
});
