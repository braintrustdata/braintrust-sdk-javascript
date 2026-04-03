import { describe, expect, it } from "vitest";
import {
  aggregateMistralStreamChunks,
  extractMistralRequestMetadata,
  extractMistralResponseMetadata,
  extractMistralToolCallsFromOutput,
  parseMistralMetricsFromUsage,
} from "./mistral-plugin";

describe("extractMistralRequestMetadata", () => {
  it("keeps only allowlisted request metadata", () => {
    expect(
      extractMistralRequestMetadata({
        model: "mistral-large-latest",
        maxTokens: 128,
        temperature: 0.4,
        n: 2,
        safe_prompt: true,
        toolChoice: "auto",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function" }],
        suffix: "ignored",
        arbitrary: "ignored",
      }),
    ).toEqual({
      model: "mistral-large-latest",
      maxTokens: 128,
      temperature: 0.4,
      n: 2,
      safe_prompt: true,
      toolChoice: "auto",
    });
  });

  it("returns empty metadata for missing input", () => {
    expect(extractMistralRequestMetadata(undefined)).toEqual({});
  });
});

describe("extractMistralResponseMetadata", () => {
  it("keeps only allowlisted response metadata", () => {
    expect(
      extractMistralResponseMetadata({
        id: "cmpl_123",
        created: 1234,
        object: "chat.completion",
        model: "mistral-large-latest",
        agentId: "agent_123",
        usage: { total_tokens: 20 },
        choices: [{ index: 0 }],
        data: [{ embedding: [0.1] }],
        arbitrary: "ignored",
      }),
    ).toEqual({
      id: "cmpl_123",
      created: 1234,
      object: "chat.completion",
      model: "mistral-large-latest",
      agentId: "agent_123",
    });
  });

  it("returns undefined when no allowlisted keys are present", () => {
    expect(
      extractMistralResponseMetadata({
        usage: { total_tokens: 20 },
        choices: [{ index: 0 }],
      }),
    ).toBeUndefined();
  });
});

describe("extractMistralToolCallsFromOutput", () => {
  it("extracts tool calls from snake_case and camelCase output", () => {
    expect(
      extractMistralToolCallsFromOutput([
        {
          index: 0,
          message: {
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
        },
        {
          index: 1,
          message: {
            toolCalls: [
              {
                id: "call_2",
                function: {
                  name: "lookup_time",
                  arguments: '{"timezone":"Europe/Vienna"}',
                },
              },
            ],
          },
        },
        {
          index: 2,
          message: {
            tool_calls: [
              {
                id: "call_3",
                function: {
                  name: "lookup_clock",
                  arguments: { city: "Vienna" },
                  output: { current_time: "09:00" },
                },
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        choiceIndex: 0,
        id: "call_1",
        index: 0,
        type: "function",
        name: "lookup_weather",
        arguments: '{"city":"Vienna"}',
      },
      {
        choiceIndex: 1,
        id: "call_2",
        name: "lookup_time",
        arguments: '{"timezone":"Europe/Vienna"}',
      },
      {
        choiceIndex: 2,
        id: "call_3",
        name: "lookup_clock",
        arguments: { city: "Vienna" },
        output: { current_time: "09:00" },
      },
    ]);
  });

  it("returns empty list for non-choice output", () => {
    expect(extractMistralToolCallsFromOutput(undefined)).toEqual([]);
    expect(extractMistralToolCallsFromOutput({})).toEqual([]);
  });
});

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

  it("merges interleaved tool call deltas by index", () => {
    const aggregated = aggregateMistralStreamChunks([
      {
        data: {
          choices: [
            {
              delta: {
                toolCalls: [
                  {
                    index: 0,
                    id: "tool_0",
                    function: {
                      name: "first_tool",
                      arguments: '{"city":"Vie',
                    },
                  },
                  {
                    index: 1,
                    id: "tool_1",
                    function: {
                      name: "second_tool",
                      arguments: '{"unit":"c"}',
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
                    index: 0,
                    id: "tool_0",
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
            index: 0,
            id: "tool_0",
            function: {
              name: "first_tool",
              arguments: '{"city":"Vienna"}',
            },
          },
          {
            index: 1,
            id: "tool_1",
            function: {
              name: "second_tool",
              arguments: '{"unit":"c"}',
            },
          },
        ],
      },
      finishReason: "tool_calls",
    });
  });

  it("keeps streamed choices separated when multiple choices are returned", () => {
    const aggregated = aggregateMistralStreamChunks([
      {
        data: {
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "a",
              },
            },
            {
              index: 1,
              delta: {
                role: "assistant",
                content: "b",
              },
            },
          ],
        },
      },
      {
        data: {
          choices: [
            {
              index: 0,
              finishReason: "stop",
            },
            {
              index: 1,
              finishReason: "length",
            },
          ],
        },
      },
    ]);

    expect(aggregated.output).toEqual([
      {
        index: 0,
        message: {
          role: "assistant",
          content: "a",
        },
        finishReason: "stop",
      },
      {
        index: 1,
        message: {
          role: "assistant",
          content: "b",
        },
        finishReason: "length",
      },
    ]);
  });
});
