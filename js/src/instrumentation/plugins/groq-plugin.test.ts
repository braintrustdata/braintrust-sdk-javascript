import { describe, expect, it } from "vitest";
import {
  aggregateGroqChatCompletionChunks,
  parseGroqMetrics,
} from "./groq-plugin";

describe("parseGroqMetrics", () => {
  it("merges OpenAI-compatible usage metrics with Groq cache metrics", () => {
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
      dram_cached_tokens: 2,
      prompt_tokens: 10,
      sram_cached_tokens: 3,
      tokens: 14,
    });
  });

  it("returns an empty object for unknown values", () => {
    expect(parseGroqMetrics(undefined)).toEqual({});
    expect(parseGroqMetrics(null)).toEqual({});
    expect(parseGroqMetrics({})).toEqual({});
  });
});

describe("aggregateGroqChatCompletionChunks", () => {
  it("preserves parsed reasoning chunks", () => {
    expect(
      aggregateGroqChatCompletionChunks([
        {
          choices: [
            {
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
              delta: {
                content: "14",
              },
              finish_reason: "stop",
            },
          ],
        },
      ]).output,
    ).toEqual([
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
  });
});
