import { describe, expect, it } from "vitest";
import {
  aggregateCohereChatStreamChunks,
  extractCohereResponseMetadata,
  parseCohereMetricsFromUsage,
} from "./cohere-plugin";

describe("parseCohereMetricsFromUsage", () => {
  it("parses usage and meta token counters", () => {
    expect(
      parseCohereMetricsFromUsage({
        usage: {
          tokens: {
            inputTokens: 10,
            outputTokens: 4,
            reasoning_tokens: 6,
          },
          cachedTokens: 3,
        },
        meta: {
          billedUnits: {
            searchUnits: 1,
          },
        },
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      reasoning_tokens: 6,
      tokens: 14,
      prompt_cached_tokens: 3,
      search_units: 1,
    });
  });

  it("returns an empty object for unknown values", () => {
    expect(parseCohereMetricsFromUsage(undefined)).toEqual({});
    expect(parseCohereMetricsFromUsage(null)).toEqual({});
    expect(parseCohereMetricsFromUsage("nope")).toEqual({});
  });
});

describe("extractCohereResponseMetadata", () => {
  it("keeps only stable metadata fields", () => {
    expect(
      extractCohereResponseMetadata({
        id: "resp_1",
        generationId: "gen_1",
        finishReason: "COMPLETE",
        meta: {
          apiVersion: {
            version: "2",
          },
          tokens: {
            inputTokens: 4,
          },
        },
      }),
    ).toEqual({
      id: "resp_1",
      generationId: "gen_1",
      finishReason: "COMPLETE",
      api_version: "2",
    });
  });
});

describe("aggregateCohereChatStreamChunks", () => {
  it("aggregates legacy v7 stream chunks", () => {
    expect(
      aggregateCohereChatStreamChunks([
        {
          eventType: "text-generation",
          text: "Hello",
        },
        {
          eventType: "text-generation",
          text: " world",
        },
        {
          eventType: "stream-end",
          response: {
            id: "resp_v7",
            finishReason: "COMPLETE",
            meta: {
              tokens: {
                inputTokens: 8,
                outputTokens: 2,
              },
            },
            text: "Hello world",
          },
        },
      ]),
    ).toEqual({
      metadata: {
        id: "resp_v7",
        finishReason: "COMPLETE",
        finish_reason: "COMPLETE",
      },
      metrics: {
        prompt_tokens: 8,
        completion_tokens: 2,
        tokens: 10,
      },
      output: "Hello world",
    });
  });

  it("aggregates v8 deltas and tool call argument chunks", () => {
    const aggregated = aggregateCohereChatStreamChunks([
      {
        type: "message-start",
        id: "resp_v8",
        delta: {
          message: {
            role: "assistant",
          },
        },
      },
      {
        type: "content-delta",
        delta: {
          message: {
            content: {
              text: "Let me check ",
            },
          },
        },
      },
      {
        type: "tool-call-start",
        index: 0,
        delta: {
          message: {
            toolCalls: {
              id: "tool_1",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: '{"city":"Vie',
              },
            },
          },
        },
      },
      {
        type: "tool-call-delta",
        index: 0,
        delta: {
          message: {
            toolCalls: {
              function: {
                arguments: 'nna"}',
              },
            },
          },
        },
      },
      {
        type: "message-end",
        delta: {
          finishReason: "COMPLETE",
          usage: {
            tokens: {
              inputTokens: 7,
              outputTokens: 3,
            },
          },
        },
      },
    ]);

    expect(aggregated.metadata).toEqual({
      id: "resp_v8",
      finish_reason: "COMPLETE",
    });
    expect(aggregated.metrics).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      tokens: 10,
    });
    expect(aggregated.output).toEqual({
      role: "assistant",
      content: "Let me check ",
      toolCalls: [
        {
          id: "tool_1",
          type: "function",
          function: {
            name: "lookup_weather",
            arguments: '{"city":"Vienna"}',
          },
        },
      ],
    });
  });

  it("aggregates v8 thinking blocks and reasoning token metrics", () => {
    const aggregated = aggregateCohereChatStreamChunks([
      {
        type: "message-start",
        id: "resp_reasoning",
        delta: {
          message: {
            role: "assistant",
          },
        },
      },
      {
        type: "content-start",
        index: 0,
        delta: {
          message: {
            content: {
              type: "thinking",
              thinking: "",
            },
          },
        },
      },
      {
        type: "content-delta",
        index: 0,
        delta: {
          message: {
            content: {
              thinking: "Let me think. ",
            },
          },
        },
      },
      {
        type: "content-delta",
        index: 0,
        delta: {
          message: {
            content: {
              thinking: "2 + 2 = 4.",
            },
          },
        },
      },
      {
        type: "content-start",
        index: 1,
        delta: {
          message: {
            content: {
              type: "text",
              text: "",
            },
          },
        },
      },
      {
        type: "content-delta",
        index: 1,
        delta: {
          message: {
            content: {
              text: "4",
            },
          },
        },
      },
      {
        type: "tool-plan-delta",
        delta: {
          message: {
            toolPlan: "Answer directly",
          },
        },
      },
      {
        type: "message-end",
        delta: {
          finishReason: "COMPLETE",
          usage: {
            tokens: {
              inputTokens: 7,
              outputTokens: 3,
              reasoning_tokens: 11,
            },
          },
        },
      },
    ]);

    expect(aggregated.metadata).toEqual({
      id: "resp_reasoning",
      finish_reason: "COMPLETE",
    });
    expect(aggregated.metrics).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      reasoning_tokens: 11,
      tokens: 10,
    });
    expect(aggregated.output).toEqual({
      role: "assistant",
      toolPlan: "Answer directly",
      content: [
        {
          type: "thinking",
          thinking: "Let me think. 2 + 2 = 4.",
        },
        {
          type: "text",
          text: "4",
        },
      ],
    });
  });
});
