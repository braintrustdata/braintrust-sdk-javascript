import { describe, expect, it, vi } from "vitest";
import { BraintrustLangChainCallbackHandler } from "./callback-handler";

function createHarness() {
  const logs: unknown[] = [];
  const span = {
    log: vi.fn((event: unknown) => {
      logs.push(event);
    }),
    end: vi.fn(),
  };
  const parent = {
    startSpan: vi.fn(() => span),
  };
  const handler = new BraintrustLangChainCallbackHandler({
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
