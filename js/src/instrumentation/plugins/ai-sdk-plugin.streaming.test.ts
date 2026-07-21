/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import * as ai from "ai";
import { configureNode } from "../../node/config";
import {
  _exportsForTestingOnly,
  initLogger,
  TestBackgroundLogger,
} from "../../logger";
import { wrapAISDK, wrapAgentClass } from "../../wrappers/ai-sdk";
import { workflowAgentWrapperSpanCountForTesting } from "../../wrappers/ai-sdk/workflow-agent-context";
import { aiSDKChannels } from "./ai-sdk-channels";
import { AISDKPlugin } from "./ai-sdk-plugin";

try {
  configureNode();
} catch {}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("AI SDK streaming instrumentation", () => {
  let backgroundLogger: TestBackgroundLogger;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "ai-sdk-plugin.streaming.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("generateText child span logs missing usage diagnostic when output has no usage", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = {
      specificationVersion: "v3",
      provider: "mock-provider",
      modelId: "mock-model",
      supportedUrls: {},
      doGenerate: async () => ({
        text: "hello",
        finishReason: "stop",
        usage: null,
      }),
      doStream: async () => {
        throw new Error("doStream should not be called");
      },
    } as any;

    const params = {
      model,
      prompt: "Say hello.",
      maxOutputTokens: 16,
    };
    const result = (await aiSDKChannels.generateText.tracePromise(
      async () => params.model.doGenerate(params),
      {
        arguments: [params],
      } as any,
    )) as any;

    expect(result.text).toBe("hello");

    const spans = (await backgroundLogger.drain()) as any[];
    const doGenerateSpan = spans.find(
      (s) => s?.span_attributes?.name === "doGenerate",
    );

    expect(doGenerateSpan?.output?.text).toBe("hello");
    expect(doGenerateSpan?.metrics?.prompt_tokens).toBeUndefined();
    expect(doGenerateSpan?.metrics?.completion_tokens).toBeUndefined();
    expect(doGenerateSpan?.metrics?.tokens).toBeUndefined();
    expect(doGenerateSpan?.metadata?.usage_unavailable_reason).toBe(
      "ai_sdk_result_missing_usage",
    );
  });

  test("streamText child span logs missing usage diagnostic when finish usage is empty", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = {
      specificationVersion: "v3",
      provider: "mock-provider",
      modelId: "mock-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("doGenerate should not be called");
      },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "text-delta",
              textDelta: "hello",
            });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: {},
            });
            controller.close();
          },
        }),
        warnings: [],
      }),
    } as any;

    const params = {
      model,
      prompt: "Say hello.",
      maxOutputTokens: 16,
    };
    const result = (await aiSDKChannels.streamText.tracePromise(
      async () => params.model.doStream(params),
      {
        arguments: [params],
      } as any,
    )) as any;

    for await (const _chunk of result.stream) {
      // Drain stream so the TransformStream flush and finish handlers run.
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const doStreamSpan = spans.find(
      (s) => s?.span_attributes?.name === "doStream",
    );

    expect(doStreamSpan?.output?.text).toBe("hello");
    expect(doStreamSpan?.output?.finishReason).toBe("stop");
    expect(doStreamSpan?.metrics?.prompt_tokens).toBeUndefined();
    expect(doStreamSpan?.metrics?.completion_tokens).toBeUndefined();
    expect(doStreamSpan?.metrics?.tokens).toBeUndefined();
    expect(doStreamSpan?.metadata?.usage_unavailable_reason).toBe(
      "ai_sdk_result_missing_usage",
    );
  });

  test("streamText child span logs accumulated output when stream ends without finish chunk", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = {
      specificationVersion: "v3",
      provider: "mock-provider",
      modelId: "mock-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("doGenerate should not be called");
      },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "text-delta",
              textDelta: "hel",
            });
            controller.enqueue({
              type: "text-delta",
              textDelta: "lo",
            });
            controller.close();
          },
        }),
        warnings: [],
      }),
    } as any;

    const params = {
      model,
      prompt: "Say hello.",
      maxOutputTokens: 16,
    };
    const result = (await aiSDKChannels.streamText.tracePromise(
      async () => params.model.doStream(params),
      {
        arguments: [params],
      } as any,
    )) as any;

    const chunks: any[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);

    const spans = (await backgroundLogger.drain()) as any[];
    const doStreamSpan = spans.find(
      (s) => s?.span_attributes?.name === "doStream",
    );

    expect(doStreamSpan?.output?.text).toBe("hello");
    expect(doStreamSpan?.output?.finishReason).toBeUndefined();
    expect(doStreamSpan?.output?.usage).toBeUndefined();
    expect(doStreamSpan?.metrics?.prompt_tokens).toBeUndefined();
    expect(doStreamSpan?.metrics?.completion_tokens).toBeUndefined();
    expect(doStreamSpan?.metrics?.tokens).toBeUndefined();
    expect(doStreamSpan?.metrics?.time_to_first_token).toBeGreaterThan(0);
    expect(doStreamSpan?.metadata?.usage_unavailable_reason).toBe(
      "ai_sdk_stream_finished_without_usage",
    );
  });

  test("streamText time_to_first_token ignores AI SDK v6 framing chunks", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const requestDelayMs = 40;
    const contentDelayMs = 80;
    let sentContent = false;
    const model = {
      specificationVersion: "v3",
      provider: "mock-delayed-provider",
      modelId: "mock-delayed-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("doGenerate should not be called");
      },
      doStream: async () => {
        await sleep(requestDelayMs);

        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "response-metadata",
                id: "response-id",
                modelId: "mock-delayed-model",
                timestamp: new Date(0),
              });
              controller.enqueue({
                type: "raw",
                rawValue: {
                  type: "response.created",
                  response: { id: "response-id" },
                },
              });
            },
            async pull(controller) {
              if (sentContent) {
                controller.close();
                return;
              }

              sentContent = true;
              await sleep(contentDelayMs);
              controller.enqueue({ type: "text-start", id: "delayed-text" });
              controller.enqueue({
                type: "text-delta",
                id: "delayed-text",
                delta: "DELAYED",
              });
              controller.enqueue({ type: "text-end", id: "delayed-text" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  outputTokens: {
                    total: 1,
                    text: 1,
                    reasoning: 0,
                  },
                },
              });
            },
          }),
          warnings: [],
        };
      },
    } as any;

    const wrappedAI = wrapAISDK(ai);
    const result = wrappedAI.streamText({
      model,
      prompt: "Reply with exactly DELAYED.",
      includeRawChunks: true,
      maxOutputTokens: 16,
    });

    let fullText = "";
    for await (const chunk of result.textStream) {
      fullText += chunk;
    }
    await result.text;

    expect(fullText).toBe("DELAYED");

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamText",
    );
    const doStreamSpan = spans.find(
      (s) => s?.span_attributes?.name === "doStream",
    );
    const minimumExpectedTTFT = (requestDelayMs + contentDelayMs) / 1000 / 2;

    expect(streamTextSpan?.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
      minimumExpectedTTFT,
    );
    expect(doStreamSpan?.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
      minimumExpectedTTFT,
    );
    expect(streamTextSpan?.output?.text).toBe("DELAYED");
    expect(doStreamSpan?.output?.text).toBe("DELAYED");
  });

  test("wrapAISDK and wrapAgentClass instrument WorkflowAgent.stream", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    class WorkflowAgent {
      #_name: string;

      constructor(options: { name: string }) {
        this.#_name = options.name;
      }

      getName() {
        return this.#_name;
      }

      async stream(params: any) {
        return {
          messages: params.messages,
          prompt: params.prompt,
          steps: [],
          text: `Streamed by ${this.#_name}`,
        };
      }
    }

    const wrappedWorkflow = wrapAISDK({ WorkflowAgent });
    const namespaceAgent = new wrappedWorkflow.WorkflowAgent({
      name: "NamespaceWorkflowAgent",
    });

    expect(namespaceAgent.getName()).toBe("NamespaceWorkflowAgent");
    await namespaceAgent.stream({
      headers: { authorization: "secret" },
      maxOutputTokens: 12,
      messages: [{ role: "user", content: "Hello" }],
      stopWhen: () => true,
    });
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    const WrappedWorkflowAgent = wrapAgentClass(WorkflowAgent);
    const directlyWrappedAgent = new WrappedWorkflowAgent({
      name: "DirectWorkflowAgent",
    });

    expect(directlyWrappedAgent.getName()).toBe("DirectWorkflowAgent");
    await directlyWrappedAgent.stream({
      headers: { authorization: "secret" },
      maxOutputTokens: 12,
      prompt: "Hello again",
      stopWhen: () => true,
      system: "You are terse.",
    });
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    const spans = (await backgroundLogger.drain()) as any[];
    const workflowSpans = spans.filter(
      (span) => span.span_attributes?.name === "WorkflowAgent.stream",
    );

    expect(workflowSpans).toHaveLength(2);
    expect(
      workflowSpans.find((span) => Array.isArray(span.input?.messages))?.input,
    ).toMatchObject({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(
      workflowSpans.find((span) => span.input?.prompt === "Hello again")?.input,
    ).toMatchObject({
      prompt: "Hello again",
      system: "You are terse.",
    });
    for (const span of workflowSpans) {
      expect(span.span_attributes).toMatchObject({
        type: "function",
        name: "WorkflowAgent.stream",
      });
      expect(span.input).not.toHaveProperty("headers");
      expect(span.input).not.toHaveProperty("maxOutputTokens");
      expect(span.input).not.toHaveProperty("stopWhen");
      expect(span.metadata).toMatchObject({
        options: {
          maxOutputTokens: 12,
          stopWhen: "[Function]",
        },
      });
      expect(span.metadata.options).not.toHaveProperty("headers");
      expect(span.output).toBeDefined();
    }
  });

  test("wrapAISDK unregisters WorkflowAgent spans when stream creation fails", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    class WorkflowAgent {
      async stream(_params?: any) {
        throw new Error("workflow stream failed");
      }
    }

    const wrappedWorkflow = wrapAISDK({ WorkflowAgent });
    const agent = new wrappedWorkflow.WorkflowAgent();

    await expect(
      agent.stream({
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toThrow("workflow stream failed");

    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);
  });

  test("wrapAISDK unregisters WorkflowAgent spans when textStream is cancelled early", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    class WorkflowAgent {
      async stream(params: any) {
        return {
          messages: params.messages,
          steps: [],
          baseStream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", delta: "first" });
            },
          }),
          textStream: (async function* () {
            yield "first";
            yield "second";
          })(),
        };
      }
    }

    const wrappedWorkflow = wrapAISDK({ WorkflowAgent });
    const agent = new wrappedWorkflow.WorkflowAgent();
    const result = await agent.stream({
      messages: [{ role: "user", content: "Hello" }],
    });

    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
      break;
    }

    expect(text).toBe("first");
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    const spans = (await backgroundLogger.drain()) as any[];
    expect(
      spans.find(
        (span) => span.span_attributes?.name === "WorkflowAgent.stream",
      ),
    ).toBeDefined();
  });

  test("wrapAISDK unregisters WorkflowAgent spans when baseStream is cancelled", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    let cancelReason: unknown;
    class WorkflowAgent {
      async stream(params: any) {
        return {
          messages: params.messages,
          steps: [],
          baseStream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", delta: "first" });
            },
            cancel(reason) {
              cancelReason = reason;
            },
          }),
        };
      }
    }

    const wrappedWorkflow = wrapAISDK({ WorkflowAgent });
    const agent = new wrappedWorkflow.WorkflowAgent();
    const result = await agent.stream({
      messages: [{ role: "user", content: "Hello" }],
    });

    const reader = result.baseStream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel("done early");

    expect(cancelReason).toBe("done early");
    expect(workflowAgentWrapperSpanCountForTesting()).toBe(0);

    const spans = (await backgroundLogger.drain()) as any[];
    expect(
      spans.find(
        (span) => span.span_attributes?.name === "WorkflowAgent.stream",
      ),
    ).toBeDefined();
  });

  test("wrapAISDK records WorkflowAgent instance tool spans", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    class WorkflowAgent {
      model: any;
      tools: any;

      constructor(options: { model: any; tools: any }) {
        this.model = options.model;
        this.tools = options.tools;
      }

      async stream(params: any) {
        await this.model.doGenerate({
          headers: { authorization: "secret" },
          maxOutputTokens: 8,
          messages: params.messages,
          temperature: 0,
        });
        const output = await this.tools.get_weather.execute({
          location: "Vienna, Austria",
        });
        return {
          messages: params.messages,
          steps: [
            {
              toolCalls: [
                {
                  toolCallId: "tool-1",
                  toolName: "get_weather",
                  input: { location: "Vienna, Austria" },
                },
              ],
              toolResults: [
                {
                  toolCallId: "tool-1",
                  toolName: "get_weather",
                  output,
                },
              ],
            },
          ],
          toolCalls: [
            {
              toolCallId: "tool-1",
              toolName: "get_weather",
              input: { location: "Vienna, Austria" },
            },
          ],
          toolResults: [
            {
              toolCallId: "tool-1",
              toolName: "get_weather",
              output,
            },
          ],
        };
      }
    }

    const wrappedWorkflow = wrapAISDK({ WorkflowAgent });
    const agent = new wrappedWorkflow.WorkflowAgent({
      model: {
        modelId: "mock-workflow-model",
        provider: "mock-provider",
        doGenerate: async () => ({
          text: "Calling get_weather.",
          usage: {
            inputTokens: 4,
            outputTokens: 3,
            totalTokens: 7,
          },
        }),
      },
      tools: {
        get_weather: {
          execute: async ({ location }: { location: string }) => ({
            condition: "sunny",
            location,
            temperatureC: 21,
          }),
        },
      },
    });

    await agent.stream({
      headers: { authorization: "secret" },
      maxOutputTokens: 12,
      messages: [{ role: "user", content: "Use get_weather." }],
    });

    const spans = (await backgroundLogger.drain()) as any[];
    const workflowSpan = spans.find(
      (span) => span.span_attributes?.name === "WorkflowAgent.stream",
    );
    const modelSpan = spans.find(
      (span) => span.span_attributes?.name === "doGenerate",
    );
    const toolSpan = spans.find(
      (span) => span.span_attributes?.name === "get_weather",
    );

    expect(workflowSpan).toBeDefined();
    expect(modelSpan).toMatchObject({
      input: { messages: [{ role: "user", content: "Use get_weather." }] },
      metadata: {
        options: {
          maxOutputTokens: 8,
          temperature: 0,
        },
      },
      output: { text: "Calling get_weather." },
      span_attributes: { name: "doGenerate", type: "llm" },
      span_parents: [workflowSpan?.span_id],
    });
    expect(workflowSpan.input).toEqual({
      messages: [{ role: "user", content: "Use get_weather." }],
    });
    expect(workflowSpan.metadata.options).toMatchObject({
      maxOutputTokens: 12,
    });
    expect(workflowSpan.input).not.toHaveProperty("headers");
    expect(workflowSpan.metadata.options).not.toHaveProperty("headers");
    expect(modelSpan.input).not.toHaveProperty("headers");
    expect(modelSpan.metadata.options).not.toHaveProperty("headers");
    expect(toolSpan).toMatchObject({
      input: { location: "Vienna, Austria" },
      output: {
        condition: "sunny",
        location: "Vienna, Austria",
        temperatureC: 21,
      },
      span_attributes: { name: "get_weather", type: "tool" },
      span_parents: [workflowSpan?.span_id],
    });
  });

  test("wrapAISDK parents concurrent WorkflowAgent child spans to the active stream", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    class WorkflowAgent {
      model: any;
      tools: any;

      constructor(options: { model: any; tools: any }) {
        this.model = options.model;
        this.tools = options.tools;
      }

      async stream(params: any) {
        await params.beforeTool;
        const generated = await this.model.doGenerate({
          messages: params.messages,
        });
        const weather = await this.tools.get_weather.execute({
          run: params.run,
        });
        return {
          messages: params.messages,
          text: `${generated.text} ${weather.run}`,
        };
      }
    }

    const wrappedWorkflow = wrapAISDK({ WorkflowAgent });
    const agent = new wrappedWorkflow.WorkflowAgent({
      model: {
        modelId: "mock-workflow-model",
        provider: "mock-provider",
        doGenerate: async ({ messages }: any) => ({
          text: messages[0].content,
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6,
          },
        }),
      },
      tools: {
        get_weather: {
          execute: async ({ run }: { run: string }) => {
            if (run === "B") {
              await sleep(20);
            }
            return { run };
          },
        },
      },
    });

    const runA = agent.stream({
      beforeTool: gateA,
      messages: [{ role: "user", content: "Run A" }],
      run: "A",
    });
    const runB = agent.stream({
      beforeTool: gateB,
      messages: [{ role: "user", content: "Run B" }],
      run: "B",
    });

    releaseA();
    releaseB();
    await Promise.all([runA, runB]);

    const spans = (await backgroundLogger.drain()) as any[];
    const workflowA = spans.find(
      (span) =>
        span.span_attributes?.name === "WorkflowAgent.stream" &&
        JSON.stringify(span.input).includes("Run A"),
    );
    const workflowB = spans.find(
      (span) =>
        span.span_attributes?.name === "WorkflowAgent.stream" &&
        JSON.stringify(span.input).includes("Run B"),
    );
    const modelA = spans.find(
      (span) =>
        span.span_attributes?.name === "doGenerate" &&
        JSON.stringify(span.input).includes("Run A"),
    );
    const modelB = spans.find(
      (span) =>
        span.span_attributes?.name === "doGenerate" &&
        JSON.stringify(span.input).includes("Run B"),
    );
    const toolA = spans.find(
      (span) =>
        span.span_attributes?.name === "get_weather" && span.input?.run === "A",
    );
    const toolB = spans.find(
      (span) =>
        span.span_attributes?.name === "get_weather" && span.input?.run === "B",
    );

    expect(workflowA).toBeDefined();
    expect(workflowB).toBeDefined();
    expect(modelA?.span_parents).toEqual([workflowA?.span_id]);
    expect(modelB?.span_parents).toEqual([workflowB?.span_id]);
    expect(toolA?.span_parents).toEqual([workflowA?.span_id]);
    expect(toolB?.span_parents).toEqual([workflowB?.span_id]);
  });

  test("streamText time_to_first_token counts streamed tool input arguments", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const contentDelayMs = 80;
    let sentContent = false;
    const result = (await aiSDKChannels.streamText.tracePromise(
      async () => ({
        baseStream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "ignored-text" });
            controller.enqueue({
              type: "tool-input-start",
              id: "call-1",
              toolName: "lookup",
            });
          },
          async pull(controller) {
            if (sentContent) {
              controller.close();
              return;
            }

            sentContent = true;
            await sleep(contentDelayMs);
            controller.enqueue({
              type: "tool-input-delta",
              id: "call-1",
              inputTextDelta: '{"query"',
            });
            controller.close();
          },
        }),
      }),
      {
        arguments: [
          {
            model: "mock-tool-model",
            prompt: "Call the lookup tool.",
          },
        ],
      } as any,
    )) as any;

    const reader = result.baseStream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamText",
    );

    expect(streamTextSpan?.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
      contentDelayMs / 1000 / 2,
    );
  });

  test("baseStream patch preserves derived stream getters", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const plugin = new AISDKPlugin();
    plugin.enable();

    try {
      let chunkSent = false;
      const result = (await aiSDKChannels.streamText.tracePromise(
        async () => {
          const resultRecord = {
            baseStream: new ReadableStream({
              pull(controller) {
                if (chunkSent) {
                  controller.close();
                  return;
                }

                chunkSent = true;
                controller.enqueue({
                  type: "text-delta",
                  id: "text-1",
                  delta: "fresh",
                });
              },
            }),
            text: Promise.resolve("fresh"),
          } as any;

          Object.defineProperty(resultRecord, "textStream", {
            configurable: true,
            enumerable: true,
            get() {
              const [textBranch, baseBranch] = this.baseStream.tee();
              this.baseStream = baseBranch;
              return textBranch.pipeThrough(
                new TransformStream({
                  transform(chunk: any, controller) {
                    if (chunk.type === "text-delta") {
                      controller.enqueue(chunk.delta);
                    }
                  },
                }),
              );
            },
          });

          return resultRecord;
        },
        {
          arguments: [
            {
              model: "mock-stream-model",
              prompt: "Reply with fresh.",
            },
          ],
        } as any,
      )) as any;

      expect(
        Object.getOwnPropertyDescriptor(result, "textStream")?.get,
      ).toEqual(expect.any(Function));

      let firstText = "";
      for await (const chunk of result.textStream) {
        firstText += chunk;
      }

      let secondText = "";
      for await (const chunk of result.textStream) {
        secondText += chunk;
      }

      expect(firstText).toBe("fresh");
      expect(secondText).toBe("fresh");
    } finally {
      plugin.disable();
    }
  });

  test("async iterable stream accessors preserve ReadableStream methods", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const plugin = new AISDKPlugin();
    plugin.enable();

    try {
      const result = (await aiSDKChannels.streamText.tracePromise(
        async () => {
          const resultRecord = {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue("v7");
                controller.close();
              },
            }),
            text: Promise.resolve("v7"),
          } as any;

          Object.defineProperty(resultRecord, "textStream", {
            configurable: true,
            enumerable: true,
            get() {
              return this.stream.pipeThrough(
                new TransformStream({
                  transform(chunk: string, controller) {
                    controller.enqueue(chunk.toUpperCase());
                  },
                }),
              );
            },
          });

          return resultRecord;
        },
        {
          arguments: [
            {
              model: "mock-v7-stream-model",
              prompt: "Reply with v7.",
            },
          ],
        } as any,
      )) as any;

      expect(result.stream.pipeThrough).toEqual(expect.any(Function));
      expect(result.stream.getReader).toEqual(expect.any(Function));

      const textStream = result.textStream;
      expect(textStream.pipeThrough).toEqual(expect.any(Function));
      expect(textStream.getReader).toEqual(expect.any(Function));

      const reader = textStream.getReader();
      const first = await reader.read();
      const second = await reader.read();

      expect(first).toEqual({ done: false, value: "V7" });
      expect(second).toEqual({ done: true, value: undefined });
    } finally {
      plugin.disable();
    }
  });

  test("wrapAgentClass instruments all HarnessAgent turn methods without serializing sessions", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const receivedParams: any[] = [];
    const usage = {
      inputTokens: { total: 7 },
      outputTokens: { total: 3 },
      totalTokens: 10,
    };
    const streamingResult = (text: string) => ({
      fullStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", text });
          controller.enqueue({ type: "finish", usage });
          controller.close();
        },
      }),
      text: Promise.resolve(text),
      totalUsage: Promise.resolve(usage),
      usage: Promise.resolve(usage),
    });

    class HarnessAgent {
      #secret = "preserved";
      readonly harnessId = "mock-harness";
      readonly permissionMode = "allow-edits";
      readonly settings: {
        shouldNeverReachCall: boolean;
        telemetry?: Record<string, unknown>;
      } = { shouldNeverReachCall: true };
      readonly tools = {
        lookup: {
          description: "Look up a value",
          inputSchema: { type: "object" },
        },
      };

      private record(params: any) {
        expect(this.#secret).toBe("preserved");
        expect(this.settings.telemetry).toEqual({});
        receivedParams.push(params);
      }

      async generate(params: any) {
        this.record(params);
        return { text: "generated", usage };
      }

      async stream(params: any) {
        this.record(params);
        return streamingResult("streamed");
      }

      async continueGenerate(params: any) {
        this.record(params);
        return { text: "continued", usage };
      }

      async continueStream(params: any) {
        this.record(params);
        return streamingResult("continued-stream");
      }
    }

    const WrappedHarnessAgent = wrapAgentClass(HarnessAgent);
    const agent = new WrappedHarnessAgent();
    const generateSession: any = { sessionId: "generate-session" };
    generateSession.self = generateSession;
    const streamSession: any = { sessionId: "stream-session" };
    streamSession.self = streamSession;
    const toolApprovalContinuations = [
      {
        approvalResponse: { id: "approval-1", approved: true },
        toolCall: {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          input: { key: "value" },
        },
      },
    ];

    await agent.generate({
      abortSignal: new AbortController().signal,
      onStepFinish: () => {},
      prompt: "generate prompt",
      providerOptions: { mock: { option: true } },
      session: generateSession,
    });
    await agent.continueGenerate({
      session: generateSession,
      toolApprovalContinuations,
    });
    const streamResult = await agent.stream({
      messages: [{ role: "user", content: "stream prompt" }],
      session: streamSession,
    });
    for await (const _chunk of streamResult.fullStream) {
      // Drain the stream so the root span records its final output and usage.
    }
    const continueStreamResult = await agent.continueStream({
      session: streamSession,
      toolApprovalContinuations,
    });
    for await (const _chunk of continueStreamResult.fullStream) {
      // Drain the stream so the root span records its final output and usage.
    }

    expect(receivedParams).toHaveLength(4);
    for (const params of receivedParams) {
      expect(params).not.toHaveProperty("shouldNeverReachCall");
      expect([generateSession, streamSession]).toContain(params.session);
    }
    expect(agent.settings).toEqual({
      shouldNeverReachCall: true,
      telemetry: {},
    });

    const spans = (await backgroundLogger.drain()) as any[];
    const harnessSpans = spans.filter((span) =>
      span.span_attributes?.name?.startsWith("HarnessAgent."),
    );
    expect(harnessSpans).toHaveLength(4);
    expect(new Set(harnessSpans.map((span) => span.root_span_id)).size).toBe(2);

    const byName = Object.fromEntries(
      harnessSpans.map((span) => [span.span_attributes.name, span]),
    );
    expect(byName["HarnessAgent.generate"]?.input).toEqual({
      prompt: "generate prompt",
    });
    expect(byName["HarnessAgent.stream"]?.input).toEqual({
      messages: [{ role: "user", content: "stream prompt" }],
    });
    expect(byName["HarnessAgent.continueGenerate"]?.input).toEqual({
      toolApprovalContinuations,
    });
    expect(byName["HarnessAgent.continueStream"]?.input).toEqual({
      toolApprovalContinuations,
    });
    expect(byName["HarnessAgent.generate"]?.span_parents).toEqual(undefined);
    expect(byName["HarnessAgent.stream"]?.span_parents).toEqual(undefined);
    expect(byName["HarnessAgent.continueGenerate"]?.span_parents).toEqual([
      byName["HarnessAgent.generate"]?.span_id,
    ]);
    expect(byName["HarnessAgent.continueStream"]?.span_parents).toEqual([
      byName["HarnessAgent.stream"]?.span_id,
    ]);

    for (const span of harnessSpans) {
      expect(span.span_attributes.type).toBe("task");
      expect(span.metadata).toMatchObject({
        harnessId: "mock-harness",
        permissionMode: "allow-edits",
        sessionId: expect.stringMatching(/-session$/),
      });
      expect(span.metadata.tools).toBeDefined();
      expect(span.input).not.toHaveProperty("session");
      expect(span.metrics).toMatchObject({
        completion_tokens: 3,
        prompt_tokens: 7,
        tokens: 10,
      });
    }
  });

  test("wrapAgentClass instruments HarnessAgent subclasses", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const receivedParams: any[] = [];
    const usage = {
      inputTokens: { total: 2 },
      outputTokens: { total: 1 },
      totalTokens: 3,
    };
    const streamingResult = (text: string) => ({
      fullStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", text });
          controller.enqueue({ type: "finish", usage });
          controller.close();
        },
      }),
      text: Promise.resolve(text),
      totalUsage: Promise.resolve(usage),
      usage: Promise.resolve(usage),
    });

    class HarnessAgent {
      readonly harnessId = "mock-harness";
      readonly permissionMode = "allow-all";
      readonly settings: Record<string, unknown> = {
        constructorOnly: true,
      };
      readonly tools = {};

      async generate(params: any) {
        receivedParams.push(params);
        return { text: "generated", usage };
      }

      async stream(params: any) {
        receivedParams.push(params);
        return streamingResult("streamed");
      }

      async continueGenerate(params: any) {
        receivedParams.push(params);
        return { text: "continued", usage };
      }

      async continueStream(params: any) {
        receivedParams.push(params);
        return streamingResult("continued-stream");
      }
    }

    class DirectSubclass extends HarnessAgent {
      async generate(params: any) {
        return super.generate(params);
      }
    }

    const WrappedDirectSubclass = wrapAgentClass(DirectSubclass);
    const WrappedHarnessAgent = wrapAgentClass(HarnessAgent);
    class SubclassOfWrappedAgent extends WrappedHarnessAgent {
      async continueStream(params: any) {
        return super.continueStream(params);
      }
    }

    const agents = [new WrappedDirectSubclass(), new SubclassOfWrappedAgent()];
    for (const [index, agent] of agents.entries()) {
      const session = { sessionId: `session-${index}` };
      await agent.generate({ prompt: `generate-${index}`, session });
      const streamResult = await agent.stream({
        messages: [{ role: "user", content: `stream-${index}` }],
        session,
      });
      for await (const _chunk of streamResult.fullStream) {
        // Drain the stream so the root span records its final output and usage.
      }
      await agent.continueGenerate({ session, toolApprovalContinuations: [] });
      const continueStreamResult = await agent.continueStream({
        session,
        toolApprovalContinuations: [],
      });
      for await (const _chunk of continueStreamResult.fullStream) {
        // Drain the stream so the root span records its final output and usage.
      }
    }

    expect(receivedParams).toHaveLength(8);
    for (const params of receivedParams) {
      expect(params).not.toHaveProperty("constructorOnly");
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const harnessSpans = spans.filter((span) =>
      span.span_attributes?.name?.startsWith("HarnessAgent."),
    );
    expect(harnessSpans).toHaveLength(8);
    expect(
      harnessSpans.map((span) => span.span_attributes.name).sort(),
    ).toEqual(
      [
        "HarnessAgent.continueGenerate",
        "HarnessAgent.continueStream",
        "HarnessAgent.generate",
        "HarnessAgent.stream",
      ]
        .flatMap((name) => [name, name])
        .sort(),
    );
    for (const span of harnessSpans) {
      expect(span.span_attributes.type).toBe("task");
      expect(span.metadata).toMatchObject({
        harnessId: "mock-harness",
        permissionMode: "allow-all",
      });
    }
  });

  test("wrapAgentClass preserves HarnessAgent turn context across serialized continuation state", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    class HarnessAgent {
      readonly harnessId = "mock-harness";
      readonly permissionMode = "allow-all";
      readonly settings: { telemetry?: Record<string, unknown> } = {};
      readonly tools = {};

      async createSession(params: {
        continueFrom?: unknown;
        sessionId?: string;
      }) {
        return {
          sessionId: params.sessionId,
          suspendTurn: async () => ({
            data: { cursor: 1 },
            harnessId: "mock-harness",
            specificationVersion: "harness-v1",
            type: "continue-turn",
          }),
        };
      }

      async generate() {
        return { text: "suspended" };
      }

      async continueGenerate() {
        return { text: "finished" };
      }
    }

    const WrappedHarnessAgent = wrapAgentClass(HarnessAgent);
    const agent = new WrappedHarnessAgent();
    const initialSession = await agent.createSession({
      sessionId: "serialized-session",
    });
    await agent.generate({
      prompt: "start",
      session: initialSession,
    });

    const continuation = JSON.parse(
      JSON.stringify(await initialSession.suspendTurn()),
    );
    const resumedSession = await agent.createSession({
      continueFrom: continuation,
      sessionId: "serialized-session",
    });
    await agent.continueGenerate({ session: resumedSession });

    const spans = (await backgroundLogger.drain()) as any[];
    const byName = Object.fromEntries(
      spans
        .filter((span) =>
          span.span_attributes?.name?.startsWith("HarnessAgent."),
        )
        .map((span) => [span.span_attributes.name, span]),
    );
    expect(Object.keys(byName)).toEqual([
      "HarnessAgent.generate",
      "HarnessAgent.continueGenerate",
    ]);
    expect(byName["HarnessAgent.continueGenerate"]?.root_span_id).toBe(
      byName["HarnessAgent.generate"]?.root_span_id,
    );
    expect(byName["HarnessAgent.continueGenerate"]?.span_parents).toEqual([
      byName["HarnessAgent.generate"]?.span_id,
    ]);
  });

  test("wrapAgentClass preserves explicit HarnessAgent telemetry settings", async () => {
    const telemetry = { isEnabled: false };

    class HarnessAgent {
      readonly harnessId = "mock-harness";
      readonly permissionMode = "allow-all";
      readonly settings = { telemetry };
      readonly tools = {};

      async generate() {
        expect(this.settings.telemetry).toBe(telemetry);
        return {
          text: "generated",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
    }

    const WrappedHarnessAgent = wrapAgentClass(HarnessAgent);
    const agent = new WrappedHarnessAgent();
    await agent.generate({ session: { sessionId: "session-123" } });

    expect(agent.settings.telemetry).toBe(telemetry);
    expect(await backgroundLogger.drain()).toHaveLength(1);
  });

  test("wrapAgentClass preserves HarnessAgent errors", async () => {
    class HarnessAgent {
      readonly harnessId = "failing-harness";
      readonly permissionMode = "allow-all";
      readonly tools = {};

      async generate() {
        throw new Error("harness turn failed");
      }
    }

    const WrappedHarnessAgent = wrapAgentClass(HarnessAgent);
    const agent = new WrappedHarnessAgent();
    await expect(
      agent.generate({ session: { sessionId: "failed-session" } }),
    ).rejects.toThrow("harness turn failed");

    const spans = (await backgroundLogger.drain()) as any[];
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      error: expect.anything(),
      metadata: {
        braintrust: expect.anything(),
        harnessId: "failing-harness",
        permissionMode: "allow-all",
        sessionId: "failed-session",
      },
      span_attributes: {
        name: "HarnessAgent.generate",
        type: "task",
      },
    });
  });
});
