import { describe, expect, it } from "vitest";
import {
  aggregateMistralStreamChunks,
  parseMistralMetricsFromUsage,
} from "./mistral-plugin";

describe("parseMistralMetricsFromUsage", () => {
  it("returns empty metrics for missing usage", () => {
    expect(parseMistralMetricsFromUsage(undefined)).toEqual({});
    expect(parseMistralMetricsFromUsage(null)).toEqual({});
  });

  it("normalizes common token counters", () => {
    expect(
      parseMistralMetricsFromUsage({
        promptTokens: 10,
        completion_tokens: 6,
        totalTokens: 16,
        promptAudioSeconds: 3,
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 6,
      tokens: 16,
      prompt_audio_seconds: 3,
    });
  });

  it("normalizes token detail counters", () => {
    expect(
      parseMistralMetricsFromUsage({
        inputTokensDetails: {
          cachedTokens: 7,
        },
        output_tokens_details: {
          reasoning_tokens: 2,
        },
      }),
    ).toEqual({
      prompt_cached_tokens: 7,
      completion_reasoning_tokens: 2,
    });
  });
});

describe("aggregateMistralStreamChunks", () => {
  it("aggregates stream text and usage into a single output row", () => {
    const aggregated = aggregateMistralStreamChunks([
      {
        data: {
          id: "cmpl_1",
          model: "mistral-small-latest",
          object: "chat.completion.chunk",
          created: 1,
          choices: [
            {
              delta: {
                role: "assistant",
                content: "Hello",
              },
            },
          ],
        },
      },
      {
        data: {
          id: "cmpl_1",
          model: "mistral-small-latest",
          object: "chat.completion.chunk",
          created: 1,
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
          choices: [
            {
              delta: {
                content: " world",
              },
              finish_reason: "stop",
            },
          ],
        },
      },
    ]);

    expect(aggregated.metrics).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 3,
      tokens: 15,
    });

    expect(aggregated.output?.[0]).toMatchObject({
      index: 0,
      message: {
        role: "assistant",
        content: "Hello world",
      },
      finishReason: "stop",
    });

    expect(aggregated.metadata).toMatchObject({
      id: "cmpl_1",
      model: "mistral-small-latest",
      object: "chat.completion.chunk",
      created: 1,
    });
  });

  it("merges tool call argument deltas", () => {
    const aggregated = aggregateMistralStreamChunks([
      {
        data: {
          choices: [
            {
              delta: {
                toolCalls: [
                  {
                    id: "tool_1",
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
      },
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "tool_1",
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
      },
    ]);

    expect(aggregated.output?.[0]).toMatchObject({
      message: {
        content: null,
        toolCalls: [
          {
            id: "tool_1",
            function: {
              name: "lookup_weather",
              arguments: '{"city":"Vienna"}',
            },
          },
        ],
      },
      finishReason: "tool_calls",
    });
  });
});
