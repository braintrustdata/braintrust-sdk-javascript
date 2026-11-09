import { describe, expect, it, vi } from "vitest";
import { BraintrustLangChainCallbackHandler } from "./callback-handler";

import { deepCopyEvent, type StartSpanArgs } from "../../logger";
import type { LangChainCaptureOptions } from "../../vendor-sdk-types/langchain";

function createHarness(options: LangChainCaptureOptions = {}) {
  const logs: unknown[] = [];
  const span = {
    log: vi.fn((event: unknown) => {
      deepCopyEvent(event as Parameters<typeof deepCopyEvent>[0]);
      logs.push(event);
    }),
    end: vi.fn(),
  };
  const parent = {
    startSpan: vi.fn((args: StartSpanArgs) => {
      deepCopyEvent(args.event ?? {});
      return span;
    }),
  };
  const handler = new BraintrustLangChainCallbackHandler({
    ...options,
    parent: parent as never,
  });

  return { handler, logs, parent, span };
}

async function finishChatModelRun(output: unknown) {
  const harness = createHarness();

  await harness.handler.handleChatModelStart(
    { name: "ChatOpenAI" },
    [[{ role: "user", content: "hello" }]],
    "run-1",
  );
  await harness.handler.handleLLMEnd(output as never, "run-1");

  const endLog = harness.logs.at(-1) as {
    metrics?: Record<string, number>;
  };
  return { ...harness, endLog };
}

describe("BraintrustLangChainCallbackHandler metrics", () => {
  it("synthesizes tokens from message usage metadata prompt and completion counts", async () => {
    const { endLog } = await finishChatModelRun({
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 2,
              },
            },
          },
        ],
      ],
    });

    expect(endLog.metrics).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      tokens: 12,
    });
  });

  it("prefers explicit total tokens from message usage metadata", async () => {
    const { endLog } = await finishChatModelRun({
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 2,
                total_tokens: 99,
              },
            },
          },
        ],
      ],
    });

    expect(endLog.metrics).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      tokens: 99,
    });
  });

  it("synthesizes tokens from llmOutput token usage prompt and completion counts", async () => {
    const { endLog } = await finishChatModelRun({
      llmOutput: {
        tokenUsage: {
          promptTokens: 10,
          completionTokens: 2,
        },
      },
    });

    expect(endLog.metrics).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      tokens: 12,
    });
  });

  it("preserves cache metrics from message usage metadata", async () => {
    const { endLog } = await finishChatModelRun({
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 2,
                input_token_details: {
                  cache_creation: 4,
                  cache_read: 3,
                },
              },
            },
          },
        ],
      ],
    });

    expect(endLog.metrics).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_cache_creation_tokens: 4,
      prompt_cached_tokens: 3,
      tokens: 12,
    });
  });

  it.each([
    {
      name: "TTL buckets without an aggregate",
      details: {
        cache_creation: undefined,
        ephemeral_5m_input_tokens: 4,
        ephemeral_1h_input_tokens: 0,
      },
      expected: {
        prompt_cache_creation_5m_tokens: 4,
        prompt_cache_creation_1h_tokens: 0,
      },
    },
    {
      name: "both TTL buckets",
      details: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
      expected: {
        prompt_cache_creation_5m_tokens: 4,
        prompt_cache_creation_1h_tokens: 6,
      },
    },
    {
      name: "a zero-valued TTL bucket",
      details: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 },
      expected: {
        prompt_cache_creation_5m_tokens: 4,
        prompt_cache_creation_1h_tokens: 0,
      },
    },
    {
      name: "only the 5-minute bucket",
      details: { ephemeral_5m_input_tokens: 4 },
      expected: { prompt_cache_creation_5m_tokens: 4 },
    },
    {
      name: "only the 1-hour bucket",
      details: { ephemeral_1h_input_tokens: 6 },
      expected: { prompt_cache_creation_1h_tokens: 6 },
    },
    {
      name: "only a zero-valued bucket",
      details: { ephemeral_1h_input_tokens: 0 },
      expected: { prompt_cache_creation_1h_tokens: 0 },
    },
    {
      name: "null TTL buckets",
      details: {
        ephemeral_5m_input_tokens: null,
        ephemeral_1h_input_tokens: null,
      },
      expected: { prompt_cache_creation_tokens: 10 },
    },
  ])(
    "preserves cache creation metrics with $name",
    async ({ details, expected }) => {
      const { endLog } = await finishChatModelRun({
        generations: [
          [
            {
              message: {
                usage_metadata: {
                  input_tokens: 20,
                  output_tokens: 2,
                  input_token_details: {
                    cache_creation: 10,
                    cache_read: 3,
                    ...details,
                  },
                },
              },
            },
          ],
        ],
      });

      expect(endLog.metrics).toEqual({
        prompt_tokens: 20,
        completion_tokens: 2,
        prompt_cached_tokens: 3,
        tokens: 22,
        ...expected,
      });
    },
  );

  it("preserves reasoning metrics from message usage metadata", async () => {
    const { endLog } = await finishChatModelRun({
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 20,
                total_tokens: 30,
                output_token_details: {
                  reasoning: 16,
                },
              },
            },
          },
        ],
      ],
    });

    expect(endLog.metrics).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      completion_reasoning_tokens: 16,
      tokens: 30,
    });
  });

  it("reports zero reasoning tokens rather than dropping the field", async () => {
    const { endLog } = await finishChatModelRun({
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 12,
                output_tokens: 2,
                total_tokens: 14,
                input_token_details: {
                  audio: 0,
                  cache_read: 0,
                },
                output_token_details: {
                  audio: 0,
                  reasoning: 0,
                },
              },
            },
          },
        ],
      ],
    });

    expect(endLog.metrics).toEqual({
      prompt_tokens: 12,
      completion_tokens: 2,
      prompt_cached_tokens: 0,
      completion_reasoning_tokens: 0,
      tokens: 14,
    });
  });
});

describe("BraintrustLangChainCallbackHandler model attribution", () => {
  it.each(["handleChatModelStart", "handleLLMStart"] as const)(
    "%s records the invocation model before completion and preserves it when the response omits it",
    async (startMethod) => {
      for (const invocationParams of [
        { model: "requested-model" },
        { model_name: "requested-model" },
      ]) {
        const { handler, logs, parent } = createHarness();
        await handler[startMethod]({ name: "LLM" }, [], "run-1", undefined, {
          invocation_params: invocationParams,
        });
        expect(parent.startSpan).toHaveBeenCalledWith(
          expect.objectContaining({
            event: expect.objectContaining({
              metadata: expect.objectContaining({ model: "requested-model" }),
            }),
          }),
        );
        await handler.handleLLMEnd({}, "run-1");
        expect(logs.at(-1)).not.toHaveProperty("metadata.model");
      }
    },
  );

  it.each([
    {
      generations: [
        [{ message: { response_metadata: { model: "resolved-model" } } }],
      ],
    },
    { llmOutput: { model_name: "resolved-model" } },
    {
      generations: [
        [{ message: { additional_kwargs: { model: "resolved-model" } } }],
      ],
    },
    {
      generations: [
        [
          {
            message: {
              response_metadata: { model_provider: "anthropic" },
              additional_kwargs: { model: "resolved-model" },
            },
          },
        ],
      ],
    },
    {
      generations: [
        [
          {
            message: {
              response_metadata: { model: "resolved-model" },
              additional_kwargs: { model: "other-model" },
            },
          },
        ],
      ],
    },
  ])(
    "prefers the response model over the requested model",
    async (response) => {
      const { handler, logs } = createHarness();
      await handler.handleChatModelStart(
        { name: "LLM" },
        [],
        "run-1",
        undefined,
        {
          invocation_params: { model: "requested-model" },
        },
      );
      await handler.handleLLMEnd(response, "run-1");
      expect(logs.at(-1)).toMatchObject({
        metadata: { model: "resolved-model" },
      });
    },
  );

  it.each(["handleChatModelStart", "handleLLMStart"] as const)(
    "%s preserves the invocation model when the call fails",
    async (startMethod) => {
      const { handler, logs, parent } = createHarness();
      await handler[startMethod]({ name: "LLM" }, [], "run-1", undefined, {
        invocation_params: { model: "requested-model" },
      });
      expect(parent.startSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            metadata: expect.objectContaining({ model: "requested-model" }),
          }),
        }),
      );
      const error = new Error("provider failed");
      await handler.handleLLMError(error, "run-1");
      expect(logs.at(-1)).toMatchObject({ error });
      expect(logs.at(-1)).not.toHaveProperty("metadata.model");
    },
  );

  it.each([undefined, null, "invalid", {}, { model: 42 }, { model: null }])(
    "does not invent a model from invalid invocation parameters (%j)",
    async (invocationParams) => {
      const { handler, logs, parent } = createHarness();
      await handler.handleChatModelStart(
        { name: "LLM" },
        [],
        "run-1",
        undefined,
        {
          invocation_params: invocationParams,
        },
      );
      expect(parent.startSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            metadata: expect.objectContaining({ model: undefined }),
          }),
        }),
      );
      await handler.handleLLMEnd({}, "run-1");
      expect(logs.at(-1)).not.toHaveProperty("metadata.model");
    },
  );
});

describe("LangChain capture options", () => {
  it.each([undefined, true, false])(
    "controls chain input and output independently (%s)",
    async (capture) => {
      for (const option of [
        "captureChainInputs",
        "captureChainOutputs",
      ] as const) {
        const { handler, parent, logs, span } = createHarness({
          [option]: capture,
        });
        const input = { messages: ["history"] };
        const output = { messages: ["answer"] };
        const kwargs = { inputs: input, retained: "metadata" };
        await handler.handleChainStart({ name: "graph" }, input, "chain");
        await handler.handleChainEnd(
          output,
          "chain",
          undefined,
          ["tag"],
          kwargs,
        );
        const startEvent = parent.startSpan.mock.calls[0][0].event!;
        const endEvent = logs[0];
        if (option === "captureChainInputs" && capture === false) {
          expect(startEvent).not.toHaveProperty("input");
          expect(endEvent).not.toHaveProperty("metadata.inputs");
        } else {
          expect(startEvent.input).toBe(input);
          expect(endEvent).toHaveProperty("metadata.inputs", input);
        }
        if (option === "captureChainOutputs" && capture === false) {
          expect(endEvent).not.toHaveProperty("output");
        } else {
          expect(endEvent).toHaveProperty("output", output);
        }
        expect(endEvent).toHaveProperty("metadata.retained", "metadata");
        expect(kwargs.inputs).toBe(input);
        expect(span.end).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([undefined, true, false])(
    "controls chain output when an agent completes first (%s)",
    async (captureChainOutputs) => {
      const { handler, logs, span } = createHarness({ captureChainOutputs });
      const output = { output: "answer" };
      const action = { returnValues: output, log: "agent finished" };
      await handler.handleChainStart({ name: "AgentExecutor" }, {}, "chain");
      await handler.handleAgentEnd(action, "chain", undefined, ["tag"]);
      await handler.handleChainEnd(output, "chain");

      expect(logs).toHaveLength(1);
      if (captureChainOutputs === false) {
        expect(logs[0]).not.toHaveProperty("output");
      } else {
        expect(logs[0]).toHaveProperty("output", action);
      }
      expect(logs[0]).toHaveProperty("metadata.tags", ["tag"]);
      expect(span.end).toHaveBeenCalledOnce();
    },
  );

  it.each(["end", "error", "agent"])(
    "never serializes suppressed chain payloads on %s",
    async (completion) => {
      const toJSON = vi.fn(() => {
        throw new Error("must not copy state");
      });
      const state = { toJSON };
      const { handler, logs, span } = createHarness({
        captureChainInputs: false,
        captureChainOutputs: false,
      });
      await handler.handleChainStart({ name: "graph" }, state, "chain");
      const kwargs = { inputs: state };
      if (completion === "error") {
        const error = new Error("chain failed");
        await handler.handleChainError(error, "chain", undefined, [], kwargs);
        expect(logs[0]).toHaveProperty("error", error);
      } else {
        if (completion === "agent") {
          await handler.handleAgentEnd(
            { returnValues: state, log: "agent finished" },
            "chain",
          );
        }
        await handler.handleChainEnd(state, "chain", undefined, [], kwargs);
      }
      expect(toJSON).not.toHaveBeenCalled();
      expect(kwargs.inputs).toBe(state);
      expect(span.end).toHaveBeenCalledOnce();
    },
  );

  it.each(["handleChatModelStart", "handleLLMStart"] as const)(
    "%s suppresses inputs before serialization and preserves errors",
    async (method) => {
      const toJSON = vi.fn(() => {
        throw new Error("must not copy messages");
      });
      const { handler, parent, logs, span } = createHarness({
        captureModelInputs: false,
      });
      await handler[method](
        { name: "model" },
        Object.assign([], { toJSON }),
        "model",
      );
      expect(parent.startSpan.mock.calls[0][0].event).not.toHaveProperty(
        "input",
      );
      const error = new Error("model failed");
      await handler.handleLLMError(error, "model");
      expect(logs[0]).toHaveProperty("error", error);
      expect(toJSON).not.toHaveBeenCalled();
      expect(span.end).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, true, false])(
    "controls model input, output and usage independently (%s)",
    async (capture) => {
      for (const option of [
        "captureModelInputs",
        "captureModelOutputs",
        "captureModelTokenUsage",
      ] as const) {
        const { handler, parent, logs, span } = createHarness({
          [option]: capture,
        });
        const messages = [[{ content: "hello" }]];
        const response = {
          llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 2 } },
        };
        await handler.handleChatModelStart(
          { name: "model" },
          messages,
          "model",
        );
        await handler.handleLLMNewToken(
          "hi",
          { prompt: 0, completion: 0 },
          "model",
        );
        await handler.handleLLMEnd(response, "model");
        const startEvent = parent.startSpan.mock.calls[0][0].event!;
        if (option === "captureModelInputs" && capture === false) {
          expect(startEvent).not.toHaveProperty("input");
        } else {
          expect(startEvent.input).toBe(messages);
        }
        if (option === "captureModelOutputs" && capture === false) {
          expect(logs[0]).not.toHaveProperty("output");
        } else {
          expect(logs[0]).toHaveProperty("output", response);
        }
        expect(logs[0]).toHaveProperty(
          "metrics.time_to_first_token",
          expect.any(Number),
        );
        if (option === "captureModelTokenUsage" && capture === false) {
          expect(logs[0]).toHaveProperty("metrics", {
            time_to_first_token: expect.any(Number),
          });
        } else {
          expect(logs[0]).toHaveProperty("metrics.tokens", 12);
        }
        expect(span.end).toHaveBeenCalledOnce();
      }
    },
  );

  it("skips result serialization and token extraction while retaining model attribution", async () => {
    const toJSON = vi.fn(() => {
      throw new Error("must not copy result");
    });
    const usage = vi.fn(() => {
      throw new Error("must not extract usage");
    });
    const response = {
      toJSON,
      generations: [
        [
          {
            message: {
              get usage_metadata() {
                return usage();
              },
              response_metadata: { model: "resolved-model" },
            },
          },
        ],
      ],
    };
    const { handler, logs } = createHarness({
      captureModelOutputs: false,
      captureModelTokenUsage: false,
    });
    await handler.handleChatModelStart({ name: "model" }, [], "model");
    await handler.handleLLMEnd(response, "model");
    expect(toJSON).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({
      metadata: { model: "resolved-model" },
      metrics: {},
    });
  });
});
