import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { openRouterChannels } from "./openrouter-channels";
import {
  aggregateOpenRouterChatChunks,
  aggregateOpenRouterResponseStreamEvents,
  parseOpenRouterMetricsFromUsage,
} from "./openrouter-plugin";

const TEST_PROVIDER = "openai";
const TEST_MODEL = "gpt-4.1-mini";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("OpenRouter Plugin", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openrouter-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  describe("parseOpenRouterMetricsFromUsage", () => {
    it("should parse chat token usage", () => {
      expect(
        parseOpenRouterMetricsFromUsage({
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          promptTokensDetails: {
            cachedTokens: 4,
            cacheWriteTokens: 2,
            audioTokens: 1,
          },
          completionTokensDetails: {
            reasoningTokens: 6,
            acceptedPredictionTokens: 3,
          },
        }),
      ).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        tokens: 30,
        prompt_cached_tokens: 4,
        prompt_cache_write_tokens: 2,
        prompt_audio_tokens: 1,
        completion_reasoning_tokens: 6,
        completion_accepted_prediction_tokens: 3,
      });
    });

    it("should parse responses usage with cost details", () => {
      expect(
        parseOpenRouterMetricsFromUsage({
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          cost: 0.0021,
          inputTokensDetails: {
            cachedTokens: 5,
          },
          outputTokensDetails: {
            reasoningTokens: 2,
          },
          costDetails: {
            upstreamInferenceCost: 0.001,
            upstreamInferenceInputCost: 0.0004,
            upstreamInferenceOutputCost: 0.0006,
          },
          isByok: true,
        }),
      ).toEqual({
        prompt_tokens: 11,
        completion_tokens: 7,
        tokens: 18,
        cost: 0.0021,
        prompt_cached_tokens: 5,
        completion_reasoning_tokens: 2,
        cost_upstream_inference_cost: 0.001,
        cost_upstream_inference_input_cost: 0.0004,
        cost_upstream_inference_output_cost: 0.0006,
      });
    });

    it("should ignore non-object usage", () => {
      expect(parseOpenRouterMetricsFromUsage(undefined)).toEqual({});
      expect(parseOpenRouterMetricsFromUsage(null)).toEqual({});
      expect(parseOpenRouterMetricsFromUsage("nope")).toEqual({});
    });
  });

  describe("aggregateOpenRouterChatChunks", () => {
    it("should aggregate assistant content, tool calls, and usage", () => {
      expect(
        aggregateOpenRouterChatChunks([
          {
            choices: [
              {
                delta: {
                  role: "assistant",
                  content: "Hello",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "lookup",
                        arguments: '{"cit',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content: " world",
                  tool_calls: [
                    {
                      function: {
                        arguments: 'y":"Vienna"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              promptTokens: 12,
              completionTokens: 8,
              totalTokens: 20,
            },
          },
        ]),
      ).toEqual({
        output: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello world",
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  type: "function",
                  function: {
                    name: "lookup",
                    arguments: '{"city":"Vienna"}',
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
        metrics: {
          prompt_tokens: 12,
          completion_tokens: 8,
          tokens: 20,
        },
      });
    });

    it("should return an empty assistant message for empty chunks", () => {
      expect(aggregateOpenRouterChatChunks([])).toEqual({
        output: [
          {
            index: 0,
            message: {
              role: undefined,
              content: undefined,
            },
            logprobs: null,
            finish_reason: undefined,
          },
        ],
        metrics: {},
      });
    });

    it("should aggregate actual SDK camelCase chunk shapes", () => {
      expect(
        aggregateOpenRouterChatChunks([
          {
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
          },
          {
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
          },
        ]),
      ).toEqual({
        output: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Let me check that.",
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  type: "function",
                  function: {
                    name: "lookup_weather",
                    arguments: '{"city":"Vienna"}',
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
        metrics: {},
      });
    });
  });

  describe("aggregateOpenRouterResponseStreamEvents", () => {
    it("should use the terminal response payload for output, metrics, and metadata", () => {
      expect(
        aggregateOpenRouterResponseStreamEvents([
          { type: "response.created" },
          {
            type: "response.output_text.delta",
            delta: "Hello",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_123",
              model: "openai/gpt-4.1-mini",
              output: [{ type: "message", role: "assistant" }],
              usage: {
                inputTokens: 9,
                outputTokens: 4,
                totalTokens: 13,
                cost: 0.0012,
                isByok: true,
              },
            },
          },
        ]),
      ).toEqual({
        output: [{ type: "message", role: "assistant" }],
        metrics: {
          prompt_tokens: 9,
          completion_tokens: 4,
          tokens: 13,
          cost: 0.0012,
        },
        metadata: {
          id: "resp_123",
          model: TEST_MODEL,
          provider: TEST_PROVIDER,
          is_byok: true,
        },
      });
    });

    it("should ignore non-terminal events", () => {
      expect(
        aggregateOpenRouterResponseStreamEvents([
          { type: "response.created" },
          { type: "response.output_text.delta", delta: "Hello" },
        ]),
      ).toEqual({
        output: undefined,
        metrics: {},
      });
    });
  });

  describe("callModel tool patching", () => {
    it("patches tools on callModel and records child llm turns plus the final response", async () => {
      const tool = {
        type: "function",
        function: {
          name: "lookup_weather",
          execute: async (params: { city: string }) => ({
            forecast: `Sunny in ${params.city}`,
          }),
        },
      };
      const initialResponse = {
        id: "resp_initial",
        model: "openai/gpt-4.1-mini",
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
        model: "openai/gpt-4.1-mini",
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
      const request = {
        input:
          "Use the lookup_weather tool for Vienna exactly once, then answer with only the forecast.",
        maxOutputTokens: 32,
        model: "openai/gpt-4.1-mini",
        tools: [tool],
      };
      const result = openRouterChannels.callModel.traceSync(
        () => {
          const modelResult = {
            allToolExecutionRounds: [],
            finalResponse,
            resolvedRequest: {
              input:
                "Use the lookup_weather tool for Vienna exactly once, then answer with only the forecast.",
              maxOutputTokens: 32,
              model: "openai/gpt-4.1-mini",
              tools: [{ type: "function", name: "lookup_weather" }],
            },
            async getInitialResponse() {
              return initialResponse;
            },
            async makeFollowupRequest(
              currentResponse: unknown,
              toolResults: unknown[],
            ) {
              modelResult.allToolExecutionRounds.push({
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
              const currentResponse = await modelResult.getInitialResponse();
              const toolResult = await request.tools[0].function.execute(
                { city: "Vienna" },
                {
                  toolCall: {
                    id: "call_1",
                    name: "lookup_weather",
                  },
                },
              );
              await modelResult.makeFollowupRequest(currentResponse, [
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

          return modelResult;
        },
        { arguments: [request] },
      );
      expect(request.tools[0]).not.toBe(tool);

      await expect(result.getText()).resolves.toBe("Sunny in Vienna");
      expect(request.tools[0]).not.toBe(tool);

      const spans = await backgroundLogger.drain();
      expect(spans).toHaveLength(4);
      const callModelSpan = spans.find(
        (span) => span.span_attributes?.name === "openrouter.callModel",
      ) as Record<string, any> | undefined;
      const turnSpans = spans.filter(
        (span) =>
          span.span_attributes?.name === "openrouter.beta.responses.send",
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
        model: TEST_MODEL,
        maxOutputTokens: 32,
        turn_count: 2,
      });
      expect(callModelSpan?.output).toMatchObject(finalResponse.output);
      expect(callModelSpan?.metrics).toMatchObject({
        prompt_tokens: 22,
        completion_tokens: 7,
        tokens: 29,
      });

      expect(turnSpans).toHaveLength(2);
      expect(turnSpans[0]?.metadata).toMatchObject({
        provider: TEST_PROVIDER,
        model: TEST_MODEL,
        id: "resp_initial",
        status: "completed",
        step: 1,
        step_type: "initial",
      });
      expect(turnSpans[1]?.metadata).toMatchObject({
        provider: TEST_PROVIDER,
        model: TEST_MODEL,
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
  });
});
