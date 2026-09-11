import { describe, expect, it } from "vitest";
import { aggregateGroqChatCompletionChunks } from "./groq-plugin";
import { extractGroqCompletionInput, parseGroqMetrics } from "./groq-span-data";

describe("Groq completion input extraction", () => {
  it("uses the same metadata allowlist for direct and batch calls", () => {
    const params = {
      messages: [{ role: "user", content: "hello" }],
      model: "llama-test",
      temperature: 0,
      max_completion_tokens: 32,
      user: "sensitive-user-id",
      unexpected: "do-not-capture",
    };
    const expected = {
      input: [{ role: "user", content: "hello" }],
      metadata: {
        max_completion_tokens: 32,
        model: "llama-test",
        provider: "groq",
        temperature: 0,
      },
    };

    expect(extractGroqCompletionInput(params)).toEqual(expected);
  });
});

describe("parseGroqMetrics", () => {
  it("normalizes Groq cache usage into prompt_cached_tokens", () => {
    expect(
      parseGroqMetrics({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        },
        x_groq: {
          usage: {
            dram_cached_tokens: 2,
            sram_cached_tokens: 3,
          },
        },
      }),
    ).toEqual({
      completion_tokens: 4,
      prompt_cached_tokens: 5,
      prompt_tokens: 10,
      tokens: 14,
    });
  });

  it("prefers canonical cached tokens over Groq hardware counters", () => {
    expect(
      parseGroqMetrics({
        usage: {
          prompt_tokens: 10,
          prompt_tokens_details: { cached_tokens: 4 },
        },
        x_groq: {
          usage: {
            dram_cached_tokens: 2,
            sram_cached_tokens: 3,
          },
        },
      }),
    ).toEqual({
      prompt_cached_tokens: 4,
      prompt_tokens: 10,
    });
  });

  it("omits Groq hardware cache usage that exceeds prompt tokens", () => {
    expect(
      parseGroqMetrics({
        usage: { prompt_tokens: 4 },
        x_groq: {
          usage: {
            dram_cached_tokens: 3,
            sram_cached_tokens: 2,
          },
        },
      }),
    ).toEqual({ prompt_tokens: 4 });
  });

  it("omits reasoning usage that exceeds completion tokens", () => {
    expect(
      parseGroqMetrics({
        usage: {
          completion_tokens: 3,
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }),
    ).toEqual({ completion_tokens: 3 });
  });

  it("returns an empty object for unknown values", () => {
    expect(parseGroqMetrics(undefined)).toEqual({});
    expect(parseGroqMetrics(null)).toEqual({});
    expect(parseGroqMetrics({})).toEqual({});
  });

  it("preserves a reported zero-token cache hit", () => {
    expect(
      parseGroqMetrics({
        usage: { prompt_tokens: 0 },
        x_groq: {
          usage: { dram_cached_tokens: 0, sram_cached_tokens: 0 },
        },
      }),
    ).toEqual({ prompt_cached_tokens: 0, prompt_tokens: 0 });
  });

  it("selects and validates only canonical token metrics", () => {
    expect(
      parseGroqMetrics({
        usage: {
          prompt_tokens: -1,
          input_tokens: 7,
          completion_tokens: 2.5,
          output_tokens: 3,
          total_tokens: Number.POSITIVE_INFINITY,
          queue_time: 0.1,
          prompt_time: 0.2,
          total_time: 0.3,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
        x_groq: {
          usage: {
            dram_cached_tokens: -4,
            sram_cached_tokens: 1,
          },
        },
      }),
    ).toEqual({
      completion_reasoning_tokens: 2,
      completion_tokens: 3,
      prompt_cached_tokens: 1,
      prompt_tokens: 7,
      tokens: 10,
    });
  });
});

describe("aggregateGroqChatCompletionChunks", () => {
  it("preserves shared stream-result metrics", () => {
    const aggregated = aggregateGroqChatCompletionChunks([], {
      __braintrust_cached_metric: 1,
    });

    expect(aggregated.metrics).toEqual({ cached: 1 });
  });

  it("preserves parsed reasoning chunks", () => {
    const aggregated = aggregateGroqChatCompletionChunks([
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              reasoning: "First, count the marbles. ",
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning: "Then double the remainder.",
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              content: "14",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          queue_time: 0.5,
        },
      },
    ]);

    expect(aggregated.output).toEqual([
      {
        finish_reason: "stop",
        index: 0,
        logprobs: null,
        message: {
          content: "14",
          reasoning: "First, count the marbles. Then double the remainder.",
          role: "assistant",
          tool_calls: undefined,
        },
      },
    ]);
    expect(aggregated.metrics).toEqual({
      completion_tokens: 4,
      prompt_tokens: 8,
      tokens: 12,
    });
  });
});
