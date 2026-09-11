import { describe, expect, it } from "vitest";
import { aggregateMistralStreamChunks } from "./mistral-plugin";
import {
  extractMistralChatInput,
  extractMistralRequestMetadata,
  extractMistralResponseMetadata,
  normalizeMistralChatChoices,
  parseMistralMetricsFromUsage,
} from "./mistral-span-data";

describe("extractMistralRequestMetadata", () => {
  it("keeps only allowlisted request metadata", () => {
    expect(
      extractMistralRequestMetadata({
        model: "mistral-large-latest",
        maxTokens: 128,
        reasoning_effort: "high",
        temperature: 0.4,
        n: 2,
        safe_prompt: true,
        toolChoice: "auto",
        parallelToolCalls: false,
        max_tool_calls: 2,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look something up",
              parameters: { type: "object" },
              strict: true,
            },
          },
          {
            type: "web_search",
            toolConfiguration: {
              include: ["news"],
              requiresConfirmation: ["open_url"],
            },
          },
          {
            type: "connector",
            connectorId: "connector-123",
            authorization: { type: "api-key", value: "secret" },
          },
        ],
        suffix: "ignored",
        arbitrary: "ignored",
      }),
    ).toEqual({
      model: "mistral-large-latest",
      max_tokens: 128,
      reasoning_effort: "high",
      temperature: 0.4,
      n: 2,
      safe_prompt: true,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_tool_calls: 2,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look something up",
            parameters: { type: "object" },
            strict: true,
          },
        },
        {
          type: "web_search",
          tool_configuration: {
            include: ["news"],
            requires_confirmation: ["open_url"],
          },
        },
        {
          type: "connector",
          connector_id: "connector-123",
        },
      ],
    });
  });

  it("normalizes Mistral's required tool choice", () => {
    expect(extractMistralRequestMetadata({ toolChoice: "any" })).toEqual({
      tool_choice: "required",
    });
  });

  it("canonicalizes camel-case and snake-case request metadata", () => {
    const camelCase = extractMistralRequestMetadata({
      agentId: "agent-123",
      maxTokens: 128,
      reasoningEffort: "high",
      responseFormat: { type: "json_object" },
      topP: 0.8,
    });

    expect(camelCase).toEqual(
      extractMistralRequestMetadata({
        agent_id: "agent-123",
        max_tokens: 128,
        reasoning_effort: "high",
        response_format: { type: "json_object" },
        top_p: 0.8,
      }),
    );
    expect(camelCase).toEqual({
      agent_id: "agent-123",
      max_tokens: 128,
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      top_p: 0.8,
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
        agentId: "legacy_agent",
        agent_id: "agent_123",
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
      agent_id: "agent_123",
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

describe("Mistral chat payload normalization", () => {
  it("normalizes input messages through the shared chat extractor", () => {
    expect(
      extractMistralChatInput({
        messages: [
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"hi"}' },
              },
            ],
          },
          { role: "tool", toolCallId: "call-1", content: "result" },
        ],
      }).input,
    ).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"hi"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ]);
  });

  it("normalizes camel-case and snake-case choices identically", () => {
    const expected = [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"hi"}' },
            },
          ],
        },
      },
    ];
    const camelCase = [
      {
        index: 0,
        finishReason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          prefix: false,
          toolCalls: expected[0].message.tool_calls,
        },
      },
    ];

    expect(normalizeMistralChatChoices(camelCase)).toEqual(expected);
    expect(
      normalizeMistralChatChoices([
        {
          index: 0,
          finish_reason: "tool_calls",
          message: expected[0].message,
        },
      ]),
    ).toEqual(expected);
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
    });
  });

  it("derives total tokens when the provider total is missing or invalid", () => {
    expect(
      parseMistralMetricsFromUsage({
        prompt_tokens: 10,
        completionTokens: 6,
        total_tokens: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 6,
      tokens: 16,
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

  it("omits unsupported and invalid metric values", () => {
    expect(
      parseMistralMetricsFromUsage({
        promptTokens: 10,
        completionTokens: -1,
        totalTokens: Number.POSITIVE_INFINITY,
        promptAudioSeconds: 3,
        arbitraryCounter: 99,
        toString: 42,
        inputTokensDetails: {
          cachedTokens: 7,
          reasoningTokens: 4,
          audioTokens: 1.5,
          arbitraryTokens: 8,
          toString: 11,
        },
        outputTokensDetails: {
          reasoningTokens: 2,
          cachedTokens: 5,
          imageTokens: Number.NaN,
        },
      }),
    ).toEqual({
      prompt_tokens: 10,
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
      finish_reason: "stop",
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
        tool_calls: [
          {
            id: "tool_1",
            function: {
              name: "lookup_weather",
              arguments: '{"city":"Vienna"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
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
        tool_calls: [
          {
            id: "tool_0",
            function: {
              name: "first_tool",
              arguments: '{"city":"Vienna"}',
            },
          },
          {
            id: "tool_1",
            function: {
              name: "second_tool",
              arguments: '{"unit":"c"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
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
        finish_reason: "stop",
      },
      {
        index: 1,
        message: {
          role: "assistant",
          content: "b",
        },
        finish_reason: "length",
      },
    ]);
  });

  it("preserves thinking content blocks from reasoning streams", () => {
    const aggregated = aggregateMistralStreamChunks([
      {
        data: {
          choices: [
            {
              delta: {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: [{ type: "text", text: "Let me" }],
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
                content: [
                  {
                    type: "thinking",
                    thinking: [{ type: "text", text: " think this through." }],
                  },
                  {
                    type: "text",
                    text: "4",
                  },
                ],
              },
              finishReason: "stop",
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
          content: [
            {
              type: "thinking",
              thinking: [
                {
                  type: "text",
                  text: "Let me think this through.",
                },
              ],
            },
            {
              type: "text",
              text: "4",
            },
          ],
        },
        finish_reason: "stop",
      },
    ]);
  });
});
