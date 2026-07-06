/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import OpenAI from "openai";
import { configureNode } from "../src/node/config";
import { _exportsForTestingOnly, Attachment, initLogger } from "../src/logger";
import { wrapClaudeAgentSDK } from "../src/wrappers/claude-agent-sdk/claude-agent-sdk";
import { wrapGoogleGenAI } from "../src/wrappers/google-genai";
import { wrapOpenAI } from "../src/wrappers/oai";
import { parseMetricsFromUsage } from "../src/wrappers/oai_responses";

function makeAPIResponse<T>(
  data: T,
  response = new Response(null, { status: 200 }),
) {
  const promise = Promise.resolve(data) as any;
  promise.withResponse = vi.fn().mockResolvedValue({ data, response });
  return promise;
}

function makeRejectingAPIResponse(error: Error) {
  const promise = Promise.resolve(undefined) as any;
  promise.withResponse = vi.fn().mockRejectedValue(error);
  return promise;
}

function makePromptMessage(content: string) {
  return {
    type: "user",
    message: { role: "user", content },
  };
}

class CustomAsyncIterable {
  public constructor(
    private messages: Array<ReturnType<typeof makePromptMessage>>,
  ) {}

  public async *[Symbol.asyncIterator]() {
    for (const message of this.messages) {
      yield message;
    }
  }
}

describe("provider wrapper", () => {
  let backgroundLogger: any;

  beforeAll(async () => {
    try {
      configureNode();
    } catch {
      // The node runtime can only be configured once per process.
    }
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "provider-wrapper-hermetic.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("OpenAI responses image outputs are converted to attachments", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const rawClient = new OpenAI({ apiKey: "sk-test" });
    const client = wrapOpenAI(rawClient);
    const mockData = {
      output: [
        {
          type: "image_generation_call",
          result:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          output_format: "png",
          revised_prompt: "A simple test image",
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    };
    const originalCreate = client.responses.create;
    client.responses.create = vi.fn(() => makeAPIResponse(mockData)) as any;

    try {
      const response = await client.responses.create({
        model: "gpt-4o-mini",
        input: "Generate a simple test image",
      });

      expect(response).toEqual(mockData);
      const spans = await backgroundLogger.drain();
      expect(spans).toHaveLength(1);
      const outputItem = spans[0].output[0];

      expect(outputItem.result).toBeInstanceOf(Attachment);
      expect(outputItem.result.reference).toMatchObject({
        type: "braintrust_attachment",
        content_type: "image/png",
      });
      expect(outputItem.result.reference.filename).toContain(
        "A_simple_test_image",
      );
    } finally {
      client.responses.create = originalCreate;
    }
  });

  test.each([
    ["withResponse", true],
    ["direct await", false],
  ])(
    "OpenAI chat completion errors do not create unhandled rejections (%s)",
    async (_name, useWithResponse) => {
      const rawClient = new OpenAI({ apiKey: "sk-test" });
      const error = new Error("api authentication failed");
      rawClient.chat.completions.create = vi.fn(() =>
        makeRejectingAPIResponse(error),
      ) as any;
      const client = wrapOpenAI(rawClient);
      let unhandledRejection: unknown = null;
      const handler = (reason: unknown) => {
        unhandledRejection = reason;
      };

      process.on("unhandledRejection", handler);
      try {
        const request = client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "test" }],
          stream: useWithResponse,
        });

        if (useWithResponse) {
          await expect(request.withResponse()).rejects.toThrow("api");
        } else {
          await expect(request).rejects.toThrow("api");
        }
      } finally {
        process.removeListener("unhandledRejection", handler);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandledRejection).toBeNull();
    },
  );

  test("OpenAI embeddings.create preserves APIPromise withResponse semantics", async () => {
    const rawClient = new OpenAI({ apiKey: "sk-test" });
    const embeddingData = {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 2, total_tokens: 2 },
    };
    const response = new Response(null, {
      status: 200,
      headers: new Headers({
        "x-ratelimit-limit-requests": "3000",
      }),
    });
    rawClient.embeddings.create = vi.fn(() =>
      makeAPIResponse(embeddingData, response),
    ) as any;
    const client = wrapOpenAI(rawClient);

    const request = client.embeddings.create({
      model: "text-embedding-3-small",
      input: "Hello world",
    });

    expect(typeof request.withResponse).toBe("function");
    const result = await request.withResponse();
    expect(result.data).toEqual(embeddingData);
    expect(result.response.headers.get("x-ratelimit-limit-requests")).toBe(
      "3000",
    );
    await expect(
      client.embeddings.create({
        model: "text-embedding-3-small",
        input: "Hello world",
      }),
    ).resolves.toEqual(embeddingData);
  });

  test("parseMetricsFromUsage handles valid and invalid usage shapes", () => {
    expect(
      parseMetricsFromUsage({
        input_tokens: 14,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 0, brand_new_token: 12 },
      }),
    ).toEqual({
      prompt_tokens: 14,
      prompt_cached_tokens: 0,
      prompt_brand_new_token: 12,
      completion_tokens: 8,
    });

    for (const input of [
      null,
      undefined,
      "not an object",
      {},
      { input_tokens: "not a number" },
      { input_tokens_details: "not an object" },
      { input_tokens_details: {} },
      { input_tokens_details: { cached_tokens: "not a number" } },
      { input_tokens_details: { cached_tokens: null } },
      { input_tokens_details: { cached_tokens: undefined } },
    ]) {
      expect(parseMetricsFromUsage(input)).toEqual({});
    }

    expect(
      parseMetricsFromUsage({
        input_tokens: 14,
        output_tokens: 8,
        input_tokens_details: null,
      }),
    ).toEqual({
      prompt_tokens: 14,
      prompt_cached_tokens: undefined,
      prompt_brand_new_token: undefined,
      completion_tokens: 8,
    });
  });

  test("Google GenAI streaming completion logs one terminal end row", async () => {
    class FakeGoogleGenAI {
      public models = {
        generateContentStream: async () =>
          (async function* () {
            yield {
              candidates: [
                { content: { parts: [{ text: "One " }], role: "model" } },
              ],
            };
            yield {
              candidates: [
                {
                  content: { parts: [{ text: "two" }], role: "model" },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 4,
                candidatesTokenCount: 2,
                totalTokenCount: 6,
              },
              text: "One two",
            };
          })(),
      };

      public constructor(_config: { apiKey?: string }) {}
    }

    const { GoogleGenAI } = wrapGoogleGenAI({ GoogleGenAI: FakeGoogleGenAI });
    const client = new GoogleGenAI({ apiKey: "test-key" }) as any;
    const stream = await client.models.generateContentStream({
      model: "gemini-2.5-flash-lite",
      contents: "Count to two.",
      config: { maxOutputTokens: 8 },
    });

    const results = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    const queued = (
      backgroundLogger as {
        items: Array<Array<{ get: () => Promise<unknown> }>>;
      }
    ).items;
    (
      backgroundLogger as {
        items: Array<Array<{ get: () => Promise<unknown> }>>;
      }
    ).items = [];
    const rawEvents = [];
    for (const batch of queued) {
      for (const event of batch) {
        rawEvents.push(await event.get());
      }
    }

    expect(results).toHaveLength(2);
    expect(rawEvents).toHaveLength(3);
    expect(rawEvents[0]).not.toMatchObject({ _is_merge: true });
    expect(rawEvents[1]).toMatchObject({
      _is_merge: true,
      output: { text: "One two" },
      metrics: {
        prompt_tokens: 4,
        completion_tokens: 2,
        tokens: 6,
      },
    });
    expect((rawEvents[1] as any).metrics.end).toBeUndefined();
    expect(rawEvents[2]).toMatchObject({
      _is_merge: true,
      metrics: { end: expect.any(Number) },
    });
  });

  test("Google GenAI chat API uses the wrapped models module", async () => {
    class FakeChats {
      public constructor(public modelsModule: any) {}

      public create(params: {
        model: string;
        config?: Record<string, unknown>;
      }) {
        return {
          sendMessage: (messageParams: { message: string }) =>
            this.modelsModule.generateContent({
              model: params.model,
              contents: messageParams.message,
              config: params.config,
            }),
        };
      }
    }

    class FakeGoogleGenAI {
      public models = {
        generateContent: async () => ({
          candidates: [
            {
              content: { parts: [{ text: "Hello" }], role: "model" },
              finishReason: "STOP",
            },
          ],
          text: "Hello",
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 1,
            totalTokenCount: 3,
          },
        }),
      };

      public chats = new FakeChats(this.models);

      public constructor(_config: { apiKey?: string }) {}
    }

    const { GoogleGenAI } = wrapGoogleGenAI({ GoogleGenAI: FakeGoogleGenAI });
    const client = new GoogleGenAI({ apiKey: "test-key" }) as any;
    const chat = client.chats.create({
      model: "gemini-2.5-flash-lite",
      config: { maxOutputTokens: 8 },
    });

    await expect(
      chat.sendMessage({ message: "Say hello." }),
    ).resolves.toMatchObject({
      text: "Hello",
    });

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_attributes: {
        type: "llm",
        name: "generate_content",
      },
      metadata: expect.objectContaining({
        model: "gemini-2.5-flash-lite",
      }),
    });
  });

  test("Claude Agent SDK forwards interrupt before and after iteration starts", async () => {
    for (const startIteration of [false, true]) {
      const interrupt = vi.fn().mockResolvedValue(undefined);
      const wrappedSDK = wrapClaudeAgentSDK({
        query: () => {
          const generator = (async function* () {
            yield { type: "assistant", message: { content: "Hello" } };
            yield { type: "result", result: "done" };
          })();
          (generator as any).interrupt = interrupt;
          return generator;
        },
      } as any) as any;
      const result = wrappedSDK.query({ prompt: "test" }) as any;

      if (startIteration) {
        await result[Symbol.asyncIterator]().next();
      }
      await result.interrupt();
      expect(interrupt).toHaveBeenCalledTimes(1);
    }
  });

  test("Claude Agent SDK forwards custom query properties and preserves async iteration", async () => {
    const wrappedSDK = wrapClaudeAgentSDK({
      query: () => {
        const generator = (async function* () {
          yield { type: "assistant", message: { content: "msg1" } };
          yield { type: "assistant", message: { content: "msg2" } };
          yield { type: "result", result: "done" };
        })();
        (generator as any).sessionId = "test-session-123";
        (generator as any).customMethod = () => "custom-value";
        return generator;
      },
    } as any) as any;

    const result = wrappedSDK.query({ prompt: "test" }) as any;
    const messages: any[] = [];
    for await (const message of result) {
      messages.push(message);
    }

    expect(messages).toHaveLength(3);
    expect(result.sessionId).toBe("test-session-123");
    expect(result.customMethod()).toBe("custom-value");
  });

  test.each([
    [
      "asyncgen_single",
      () =>
        (async function* () {
          yield makePromptMessage("What is 2 + 2?");
        })(),
      ["What is 2 + 2?"],
    ],
    [
      "asyncgen_multi",
      () =>
        (async function* () {
          yield makePromptMessage("Part 1");
          yield makePromptMessage("Part 2");
        })(),
      ["Part 1", "Part 2"],
    ],
    [
      "custom_async_iterable",
      () =>
        new CustomAsyncIterable([
          makePromptMessage("Custom 1"),
          makePromptMessage("Custom 2"),
        ]),
      ["Custom 1", "Custom 2"],
    ],
  ])(
    "Claude Agent SDK captures async iterable prompt input (%s)",
    async (_name, inputFactory, expected) => {
      const wrappedSDK = wrapClaudeAgentSDK({
        query: ({ prompt }: any) => {
          const generator = (async function* () {
            if (prompt && typeof prompt[Symbol.asyncIterator] === "function") {
              for await (const _ of prompt) {
              }
            }
            yield {
              type: "assistant",
              message: {
                role: "assistant",
                content: "Hello!",
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })();
          return generator;
        },
      });

      for await (const _message of wrappedSDK.query({
        prompt: inputFactory(),
      } as any)) {
      }

      const spans = await backgroundLogger.drain();
      const taskSpan = spans.find(
        (span: any) => span.span_attributes.name === "Claude Agent",
      );
      const llmSpan = spans.find(
        (span: any) =>
          span.span_attributes.name === "anthropic.messages.create",
      );

      expect(taskSpan?.input.map((item: any) => item.message?.content)).toEqual(
        expected,
      );
      expect(llmSpan?.input.map((item: any) => item.content)).toEqual(expected);
    },
  );

  test("Claude Agent SDK keeps parented user tool results in sub-agent conversation history", async () => {
    const rootPrompt = "Delegate the calculation.";
    const subAgentPrompt = "Use the calculator to add 15 and 27.";
    let capturedOptions: any;
    const wrappedSDK = wrapClaudeAgentSDK({
      query: (params: any) => {
        capturedOptions = params.options;
        return (async function* () {
          yield {
            type: "assistant",
            message: {
              id: "root-assistant",
              role: "assistant",
              content: [
                {
                  id: "agent-tool-use",
                  input: {
                    description: "math specialist",
                    prompt: subAgentPrompt,
                    subagent_type: "math-expert",
                  },
                  name: "Agent",
                  type: "tool_use",
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "user",
            parent_tool_use_id: "agent-tool-use",
            message: {
              role: "user",
              content: [{ text: subAgentPrompt, type: "text" }],
            },
          };
          yield {
            type: "assistant",
            parent_tool_use_id: "agent-tool-use",
            message: {
              id: "sub-agent-tool-call",
              role: "assistant",
              content: [
                {
                  id: "calculator-tool-use",
                  input: { a: 15, b: 27, operation: "add" },
                  name: "mcp__calculator__calculator",
                  type: "tool_use",
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "user",
            parent_tool_use_id: "agent-tool-use",
            message: {
              role: "user",
              content: [
                {
                  content: "42",
                  tool_use_id: "calculator-tool-use",
                  type: "tool_result",
                },
              ],
            },
          };
          yield {
            type: "assistant",
            parent_tool_use_id: "agent-tool-use",
            message: {
              id: "sub-agent-final",
              role: "assistant",
              content: [{ text: "The answer is 42.", type: "text" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 3 },
          };
        })();
      },
    });

    for await (const message of wrappedSDK.query({
      prompt: rootPrompt,
      options: { model: "test-model" },
    } as any)) {
      if (
        message.type === "assistant" &&
        message.message?.id === "sub-agent-tool-call"
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await capturedOptions.hooks.PreToolUse.at(-1).hooks[0](
          {
            hook_event_name: "PreToolUse",
            tool_name: "mcp__calculator__calculator",
            tool_input: { a: 15, b: 27, operation: "add" },
            session_id: "test-session",
            transcript_path: "/tmp/transcript",
            cwd: "/tmp",
          },
          "calculator-tool-use",
          { signal: new AbortController().signal },
        );
        await capturedOptions.hooks.PostToolUse.at(-1).hooks[0](
          {
            hook_event_name: "PostToolUse",
            tool_name: "mcp__calculator__calculator",
            tool_input: { a: 15, b: 27, operation: "add" },
            tool_response: "42",
            session_id: "test-session",
            transcript_path: "/tmp/transcript",
            cwd: "/tmp",
          },
          "calculator-tool-use",
          { signal: new AbortController().signal },
        );
      }
    }

    const spans = await backgroundLogger.drain();
    const finalSubAgentLlm = spans.find(
      (span: any) =>
        span.span_attributes.name === "anthropic.messages.create" &&
        Array.isArray(span.output) &&
        span.output.some((message: any) =>
          message.content?.some?.(
            (block: any) => block.text === "The answer is 42.",
          ),
        ),
    );

    expect(finalSubAgentLlm?.input).toMatchObject([
      {
        content: [{ text: subAgentPrompt, type: "text" }],
        role: "user",
      },
      {
        content: [
          {
            id: "calculator-tool-use",
            name: "mcp__calculator__calculator",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            content: "42",
            tool_use_id: "calculator-tool-use",
            type: "tool_result",
          },
        ],
        role: "user",
      },
    ]);
    expect(JSON.stringify(finalSubAgentLlm?.input)).not.toContain(rootPrompt);

    const subAgentSpan = spans.find(
      (span: any) => span.span_attributes.name === "Agent: math specialist",
    );
    const calculatorToolSpan = spans.find(
      (span: any) =>
        span.span_attributes.name === "tool: calculator/calculator",
    );
    expect(calculatorToolSpan?.span_parents).toEqual([subAgentSpan?.span_id]);
  });

  test("Claude Agent SDK does not create duplicate LLM spans for late built-in tool hooks", async () => {
    let capturedOptions: any;
    const rootPrompt = "Delegate to an echo agent.";
    const toolUseID = "agent-tool-use";
    const wrappedSDK = wrapClaudeAgentSDK({
      query: (params: any) => {
        capturedOptions = params.options;
        return (async function* () {
          yield {
            type: "assistant",
            message: {
              id: "root-assistant",
              role: "assistant",
              content: [
                {
                  id: toolUseID,
                  input: {
                    description: "echo greeting",
                    prompt: "Run a bash echo command.",
                    subagent_type: "echo",
                  },
                  name: "Agent",
                  type: "tool_use",
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "user",
            parent_tool_use_id: toolUseID,
            message: {
              role: "user",
              content: [{ text: "Run a bash echo command.", type: "text" }],
            },
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })();
      },
    });

    for await (const message of wrappedSDK.query({
      prompt: rootPrompt,
      options: { model: "test-model" },
    } as any)) {
      if (message.type === "user" && message.parent_tool_use_id === toolUseID) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await capturedOptions.hooks.PreToolUse.at(-1).hooks[0](
          {
            hook_event_name: "PreToolUse",
            tool_name: "Agent",
            tool_input: {
              description: "echo greeting",
              prompt: "Run a bash echo command.",
              subagent_type: "echo",
            },
            session_id: "test-session",
            transcript_path: "/tmp/transcript",
            cwd: "/tmp",
          },
          toolUseID,
          { signal: new AbortController().signal },
        );
      }
    }

    const spans = await backgroundLogger.drain();
    const taskSpan = spans.find(
      (span: any) => span.span_attributes.name === "Claude Agent",
    );
    const rootLlmSpans = spans.filter(
      (span: any) =>
        span.span_attributes.name === "anthropic.messages.create" &&
        span.span_parents?.includes(taskSpan?.span_id),
    );

    expect(rootLlmSpans).toHaveLength(1);
    expect(rootLlmSpans[0]?.input).toEqual([
      {
        content: rootPrompt,
        role: "user",
      },
    ]);
    expect(rootLlmSpans[0]?.output).toMatchObject([
      {
        content: [
          {
            id: toolUseID,
            name: "Agent",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("Claude Agent SDK injects tracing hooks while preserving user hooks", async () => {
    let capturedOptions: any;
    const userPreHook = vi.fn().mockResolvedValue({});
    const userPostHook = vi.fn().mockResolvedValue({});
    const wrappedSDK = wrapClaudeAgentSDK({
      query: (params: any) => {
        capturedOptions = params.options;
        return (async function* () {
          yield { type: "result", result: "done" };
        })();
      },
    });

    for await (const _message of wrappedSDK.query({
      prompt: "test",
      options: {
        model: "test-model",
        hooks: {
          PreToolUse: [{ hooks: [userPreHook] }],
          PostToolUse: [{ hooks: [userPostHook] }],
        },
      },
    } as any)) {
    }

    expect(capturedOptions.hooks.PreToolUse[0].hooks[0]).toBe(userPreHook);
    expect(capturedOptions.hooks.PostToolUse[0].hooks[0]).toBe(userPostHook);
    expect(capturedOptions.hooks.PreToolUse.length).toBeGreaterThanOrEqual(2);
    expect(capturedOptions.hooks.PostToolUse.length).toBeGreaterThanOrEqual(2);
    expect(capturedOptions.hooks.PostToolUseFailure.length).toBeGreaterThan(0);
    expect(capturedOptions.hooks.SubagentStart.length).toBeGreaterThan(0);
    expect(capturedOptions.hooks.SubagentStop.length).toBeGreaterThan(0);
  });

  test.each([
    ["PreToolUse", "PreToolUse"],
    ["PostToolUse", "PostToolUse"],
    ["PostToolUseFailure", "PostToolUseFailure"],
  ])(
    "Claude Agent SDK %s hook handles undefined toolUseID gracefully",
    async (_name, hookName) => {
      let capturedOptions: any;
      const wrappedSDK = wrapClaudeAgentSDK({
        query: (params: any) => {
          capturedOptions = params.options;
          return (async function* () {
            yield { type: "result", result: "done" };
          })();
        },
      });

      for await (const _message of wrappedSDK.query({
        prompt: "test",
        options: { model: "test-model" },
      } as any)) {
      }

      const hook = capturedOptions.hooks[hookName][0].hooks[0];
      await expect(
        hook(
          {
            hook_event_name: hookName,
            tool_name: "test_tool",
            tool_input: { arg: "value" },
            session_id: "test-session",
            transcript_path: "/tmp/transcript",
            cwd: "/tmp",
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      ).resolves.toEqual({});
    },
  );

  test("Claude Agent SDK PostToolUseFailure hook logs error to tool span", async () => {
    let capturedOptions: any;
    const wrappedSDK = wrapClaudeAgentSDK({
      query: (params: any) => {
        capturedOptions = params.options;
        return (async function* () {
          yield { type: "result", result: "done" };
        })();
      },
    });

    for await (const _message of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    } as any)) {
    }

    const toolUseID = "test-tool-use-id";
    await capturedOptions.hooks.PreToolUse[0].hooks[0](
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__server__tool",
        tool_input: { arg: "value" },
        session_id: "test-session",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      toolUseID,
      { signal: new AbortController().signal },
    );

    await expect(
      capturedOptions.hooks.PostToolUseFailure[0].hooks[0](
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "mcp__server__tool",
          tool_input: { arg: "value" },
          error: "Tool execution failed: connection timeout",
          is_interrupt: false,
          session_id: "test-session",
          transcript_path: "/tmp/transcript",
          cwd: "/tmp",
        },
        toolUseID,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({});

    const spans = await backgroundLogger.drain();
    const toolSpan = spans.find(
      (span: any) => span.span_attributes.type === "tool",
    );
    expect(toolSpan?.error).toBe("Tool execution failed: connection timeout");
  });
});
