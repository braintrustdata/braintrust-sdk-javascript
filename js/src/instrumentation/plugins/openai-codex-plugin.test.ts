import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStartSpan } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
}));

vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
}));

import iso from "../../isomorph";
import { OpenAICodexPlugin } from "./openai-codex-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("OpenAICodexPlugin", () => {
  let handlersByName: Map<string, any>;
  let spans: Array<{
    end: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    name?: string;
  }>;

  beforeEach(() => {
    handlersByName = new Map();
    spans = [];
    mockNewTracingChannel.mockImplementation((name: string) => ({
      subscribe: vi.fn((handlers) => handlersByName.set(name, handlers)),
      unsubscribe: vi.fn(),
    }));
    mockStartSpan.mockImplementation((args: any) => {
      const span = {
        end: vi.fn(),
        export: vi.fn(async () => `${args.name}-export-${spans.length}`),
        log: vi.fn(),
        name: args.name,
      };
      if (args.event) {
        span.log(args.event);
      }
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses explicit token totals by precedence instead of summing breakdowns", async () => {
    const plugin = new OpenAICodexPlugin();
    plugin.enable();

    const runHandlers = handlersByName.get(
      "orchestrion:@openai/codex-sdk:Thread.run",
    );
    const event = {
      arguments: ["hello", undefined],
      result: {
        finalResponse: "done",
        items: [{ id: "msg-1", text: "done", type: "agent_message" }],
        usage: {
          cached_input_tokens: 3,
          input_tokens: 11,
          output_tokens: 7,
          reasoning_output_tokens: 5,
          tokens: 19,
          totalTokens: 18,
          total_tokens: 20,
        },
      },
      thread: { id: "thread-1" },
    };

    runHandlers.start(event);
    await runHandlers.asyncEnd(event);

    const rootSpan = spans.find((span) => span.name === "OpenAI Codex");
    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          completion_reasoning_tokens: 5,
          completion_tokens: 7,
          prompt_cached_tokens: 3,
          prompt_tokens: 11,
          tokens: 18,
        }),
      }),
    );
  });
});
