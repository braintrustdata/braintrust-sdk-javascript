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
import { wrapOpenRouter } from "./openrouter";

const TEST_MODEL = "openai/gpt-4.1-mini";
const TEST_MODEL_ID = "gpt-4.1-mini";
const TEST_PROVIDER = "openai";
const TEST_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const TEST_EMBEDDING_MODEL_ID = "text-embedding-3-small";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("openrouter wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openrouter.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  test("returns the original object for unsupported clients", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = { foo: "bar" };

    expect(wrapOpenRouter(invalid)).toBe(invalid);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported OpenRouter library. Not wrapping.",
    );
  });

  test("wraps chat.send and emits plugin-consumable channel events", async () => {
    const request = {
      chatGenerationParams: {
        model: TEST_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
      },
    };
    const options = { timeoutMs: 1234 };
    const send = vi.fn(async (actualRequest, actualOptions) => {
      expect(actualRequest).toBe(request);
      expect(actualOptions).toBe(options);
      return {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "OK",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          promptTokens: 5,
          completionTokens: 1,
          totalTokens: 6,
        },
      };
    });

    const client = wrapOpenRouter({
      chat: { send },
      embeddings: { generate: vi.fn() },
    });

    const result = await client.chat.send(request, options);
    expect(result).toMatchObject({
      choices: [
        {
          message: {
            content: "OK",
          },
        },
      ],
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as Record<string, any>;
    expect(span.span_attributes).toMatchObject({
      name: "openrouter.chat.send",
      type: "llm",
    });
    expect(span.input).toEqual(request.chatGenerationParams.messages);
    expect(span.metadata).toMatchObject({
      provider: TEST_PROVIDER,
      model: TEST_MODEL_ID,
      temperature: 0,
    });
    expect(span.output).toMatchObject([
      {
        message: {
          role: "assistant",
          content: "OK",
        },
      },
    ]);
    expect(span.metrics).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 1,
      tokens: 6,
    });
  });

  test("wraps streaming chat.send without collecting stream state in the wrapper", async () => {
    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              role: "assistant",
              content: "Let me check ",
              toolCalls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "lookup_weather",
                    arguments: '{"city":"Vie',
                  },
                },
              ],
            },
          },
        ],
      };

      yield {
        choices: [
          {
            delta: {
              content: "that.",
              toolCalls: [
                {
                  index: 0,
                  function: {
                    arguments: 'nna"}',
                  },
                },
              ],
            },
            finishReason: "tool_calls",
          },
        ],
        usage: {
          promptTokens: 7,
          completionTokens: 4,
          totalTokens: 11,
        },
      };
    }

    const send = vi.fn(async () => stream());
    const client = wrapOpenRouter({
      chat: { send },
      embeddings: { generate: vi.fn() },
    });

    const result = await client.chat.send({
      chatGenerationParams: {
        model: TEST_MODEL,
        stream: true,
        messages: [{ role: "user", content: "Use the tool." }],
      },
    });

    const chunks = [];
    for await (const chunk of result as AsyncIterable<unknown>) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as Record<string, any>;
    expect(span.span_attributes.name).toBe("openrouter.chat.send");
    expect(span.output).toMatchObject([
      {
        message: {
          role: "assistant",
          content: "Let me check that.",
          tool_calls: [
            {
              function: {
                name: "lookup_weather",
                arguments: '{"city":"Vienna"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ]);
    expect(span.metrics).toMatchObject({
      time_to_first_token: expect.any(Number),
      prompt_tokens: 7,
      completion_tokens: 4,
      tokens: 11,
    });
  });

  test("wraps responses.send and embeddings.generate", async () => {
    const responsesSend = vi.fn(async () => ({
      id: "resp_123",
      model: TEST_MODEL,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Observability helps." }],
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      },
    }));
    const embeddingsGenerate = vi.fn(async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: {
        promptTokens: 4,
        totalTokens: 4,
      },
    }));

    const client = wrapOpenRouter({
      chat: { send: vi.fn() },
      beta: {
        responses: {
          send: responsesSend,
        },
      },
      embeddings: {
        generate: embeddingsGenerate,
      },
    });

    await client.beta.responses.send({
      openResponsesRequest: {
        model: TEST_MODEL,
        input: "Say one short sentence about observability.",
        maxOutputTokens: 16,
      },
    });
    await client.embeddings.generate({
      requestBody: {
        model: TEST_EMBEDDING_MODEL,
        input: "braintrust tracing",
        inputType: "query",
      },
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);

    const responseSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "openrouter.beta.responses.send",
    ) as Record<string, any> | undefined;
    const embeddingSpan = spans.find(
      (span: any) =>
        span.span_attributes?.name === "openrouter.embeddings.generate",
    ) as Record<string, any> | undefined;

    expect(responseSpan).toBeDefined();
    expect(responseSpan?.metadata).toMatchObject({
      provider: TEST_PROVIDER,
      model: TEST_MODEL_ID,
      status: "completed",
      id: "resp_123",
    });
    expect(responseSpan?.output).toMatchObject([
      {
        type: "message",
        role: "assistant",
      },
    ]);
    expect(responseSpan?.metrics).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 3,
      tokens: 13,
    });

    expect(embeddingSpan).toBeDefined();
    expect(embeddingSpan?.metadata).toMatchObject({
      provider: TEST_PROVIDER,
      model: TEST_EMBEDDING_MODEL_ID,
      embedding_model: TEST_EMBEDDING_MODEL_ID,
      inputType: "query",
    });
    expect(embeddingSpan?.output).toMatchObject({
      embedding_length: 3,
    });
    expect(embeddingSpan?.metrics).toMatchObject({
      prompt_tokens: 4,
      tokens: 4,
    });
  });

  test("wraps callModel tool execution with tool spans", async () => {
    const initialResponse = {
      id: "resp_initial",
      model: TEST_MODEL,
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          callId: "call_1",
          name: "lookup_weather",
          arguments: '{"city":"Vienna"}',
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    };
    const finalResponse = {
      id: "resp_final",
      model: TEST_MODEL,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Sunny in Vienna" }],
        },
      ],
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    };
    const callModel = vi.fn((request) => {
      const result = {
        allToolExecutionRounds: [],
        finalResponse,
        resolvedRequest: {
          input:
            "Use the lookup_weather tool for Vienna exactly once, then answer with only the forecast.",
          maxOutputTokens: 32,
          model: TEST_MODEL,
          tools: [{ type: "function", name: "lookup_weather" }],
        },
        async getInitialResponse() {
          return initialResponse;
        },
        async makeFollowupRequest(
          currentResponse: unknown,
          toolResults: unknown[],
        ) {
          result.allToolExecutionRounds.push({
            round: 0,
            response: currentResponse,
            toolResults,
          });
          return finalResponse;
        },
        async getResponse() {
          return finalResponse;
        },
        async getText() {
          const currentResponse = await result.getInitialResponse();
          const tool = request.tools[0];
          const toolResult = await tool.function.execute(
            { city: "Vienna" },
            {
              toolCall: {
                id: "call_1",
                name: "lookup_weather",
              },
            },
          );
          await result.makeFollowupRequest(currentResponse, [
            {
              type: "function_call_output",
              id: "output_call_1",
              callId: "call_1",
              output: JSON.stringify(toolResult),
            },
          ]);
          return "Sunny in Vienna";
        },
      };

      return result;
    });

    const client = wrapOpenRouter({
      callModel,
    });

    const result = client.callModel({
      input:
        "Use the lookup_weather tool for Vienna exactly once, then answer with only the forecast.",
      maxOutputTokens: 32,
      model: TEST_MODEL,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            execute: async (params: { city: string }) => ({
              forecast: `Sunny in ${params.city}`,
            }),
          },
        },
      ],
    });

    await expect(result.getText()).resolves.toBe("Sunny in Vienna");

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(4);
    const callModelSpan = spans.find(
      (span) => span.span_attributes?.name === "openrouter.callModel",
    ) as Record<string, any> | undefined;
    const turnSpans = spans.filter(
      (span) => span.span_attributes?.name === "openrouter.beta.responses.send",
    ) as Array<Record<string, any>>;
    const toolSpan = spans.find(
      (span) => span.span_attributes?.name === "lookup_weather",
    ) as Record<string, any> | undefined;

    expect(callModelSpan?.span_attributes).toMatchObject({
      name: "openrouter.callModel",
      type: "llm",
    });
    expect(callModelSpan?.metadata).toMatchObject({
      provider: TEST_PROVIDER,
      model: TEST_MODEL_ID,
      maxOutputTokens: 32,
      turn_count: 2,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
          },
        },
      ],
    });
    expect(
      callModelSpan?.metadata?.tools?.[0]?.function?.execute,
    ).toBeUndefined();
    expect(callModelSpan?.output).toMatchObject(finalResponse.output);
    expect(callModelSpan?.metrics).toMatchObject({
      prompt_tokens: 22,
      completion_tokens: 7,
      tokens: 29,
    });

    expect(turnSpans).toHaveLength(2);
    expect(turnSpans[0]?.input).toBe(
      "Use the lookup_weather tool for Vienna exactly once, then answer with only the forecast.",
    );
    expect(turnSpans[0]?.output).toMatchObject(initialResponse.output);
    expect(turnSpans[0]?.metadata).toMatchObject({
      provider: TEST_PROVIDER,
      model: TEST_MODEL_ID,
      id: "resp_initial",
      status: "completed",
      step: 1,
      step_type: "initial",
    });
    expect(turnSpans[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          callId: "call_1",
        }),
        expect.objectContaining({
          type: "function_call_output",
          callId: "call_1",
        }),
      ]),
    );
    expect(turnSpans[1]?.output).toMatchObject(finalResponse.output);
    expect(turnSpans[1]?.metadata).toMatchObject({
      provider: TEST_PROVIDER,
      model: TEST_MODEL_ID,
      id: "resp_final",
      status: "completed",
      step: 2,
      step_type: "continue",
    });

    expect(toolSpan?.span_attributes).toMatchObject({
      name: "lookup_weather",
      type: "tool",
    });
    expect(toolSpan?.input).toMatchObject({
      city: "Vienna",
    });
    expect(toolSpan?.metadata).toMatchObject({
      provider: "openrouter",
      tool_name: "lookup_weather",
      tool_call_id: "call_1",
    });
    expect(toolSpan?.output).toMatchObject({
      forecast: "Sunny in Vienna",
    });
  });

  test("wraps generator tools in callModel and logs the final yielded value", async () => {
    const callModel = vi.fn((request) => {
      const tool = request.tools[0];
      return tool.function.execute(
        { city: "Vienna" },
        {
          toolCall: {
            id: "call_2",
            name: "lookup_weather",
          },
        },
      );
    });

    const client = wrapOpenRouter({
      callModel,
    });

    const result = client.callModel({
      model: TEST_MODEL,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            async *execute(params: { city: string }) {
              yield { status: `Fetching ${params.city}` };
              yield { forecast: `Sunny in ${params.city}` };
            },
          },
        },
      ],
    });

    const chunks = [];
    for await (const chunk of result as AsyncIterable<unknown>) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);
    const callModelSpan = spans.find(
      (span) => span.span_attributes?.name === "openrouter.callModel",
    ) as Record<string, any> | undefined;
    const toolSpan = spans.find(
      (span) => span.span_attributes?.name === "lookup_weather",
    ) as Record<string, any> | undefined;

    expect(callModelSpan?.span_attributes).toMatchObject({
      name: "openrouter.callModel",
      type: "llm",
    });
    expect(callModelSpan?.metadata).toMatchObject({
      provider: TEST_PROVIDER,
      model: TEST_MODEL_ID,
    });

    expect(toolSpan?.span_attributes).toMatchObject({
      name: "lookup_weather",
      type: "tool",
    });
    expect(toolSpan?.input).toMatchObject({
      city: "Vienna",
    });
    expect(toolSpan?.output).toMatchObject({
      forecast: "Sunny in Vienna",
    });
  });
});
