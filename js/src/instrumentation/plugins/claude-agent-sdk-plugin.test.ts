import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
const streamPatcherMock = vi.hoisted(() => ({
  options: undefined as
    | {
        onChunk?: (chunk: unknown) => void | Promise<void>;
        onComplete: () => void | Promise<void>;
      }
    | undefined,
}));

vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../core/stream-patcher", () => ({
  isAsyncIterable: vi.fn(
    (val: unknown) =>
      val !== null &&
      typeof val === "object" &&
      Symbol.asyncIterator in val &&
      typeof (val as any)[Symbol.asyncIterator] === "function",
  ),
  patchStreamIfNeeded: vi.fn((stream, options) => {
    streamPatcherMock.options = options;
    return stream;
  }),
}));

import { ClaudeAgentSDKPlugin } from "./claude-agent-sdk-plugin";
import iso from "../../isomorph";
import { startSpan } from "../../logger";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

// Mock the logger module
vi.mock("../../logger", () => ({
  startSpan: vi.fn(() => ({
    log: vi.fn(),
    end: vi.fn(),
    export: vi.fn(() => Promise.resolve({})),
  })),
}));

// Mock utility modules
vi.mock("../../../util/index", () => ({
  SpanTypeAttribute: {
    TASK: "task",
    LLM: "llm",
    TOOL: "tool",
  },
  isObject: vi.fn((val: unknown) => val !== null && typeof val === "object"),
}));

vi.mock("../../../util", () => ({
  getCurrentUnixTimestamp: vi.fn(() => 1000),
  SpanTypeAttribute: {
    TASK: "task",
    LLM: "llm",
    TOOL: "tool",
  },
}));

vi.mock("../../wrappers/attachment-utils", () => ({
  processInputAttachments: vi.fn((input) => input),
}));

// `anthropic-tokens-util` is pure and owns the cache-creation representation
// rules, so these tests run the real implementation rather than a stand-in that
// could drift from it.

vi.mock("../core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core")>();

  return {
    ...actual,
    BasePlugin: class BasePlugin {
      protected enabled = false;
      protected unsubscribers: Array<() => void> = [];

      enable(): void {
        if (this.enabled) {
          return;
        }
        this.enabled = true;
        this.onEnable();
      }

      disable(): void {
        if (!this.enabled) {
          return;
        }
        this.enabled = false;
        this.onDisable();
      }

      protected onEnable(): void {
        // To be implemented by subclass
      }

      protected onDisable(): void {
        // To be implemented by subclass
      }
    },
    isAsyncIterable: vi.fn(
      (val: unknown) =>
        val !== null &&
        typeof val === "object" &&
        Symbol.asyncIterator in val &&
        typeof (val as any)[Symbol.asyncIterator] === "function",
    ),
    patchStreamIfNeeded: vi.fn((stream, _callbacks) => {
      // Return the stream unchanged for simple tests
      return stream;
    }),
  };
});

describe("ClaudeAgentSDKPlugin", () => {
  let plugin: ClaudeAgentSDKPlugin;
  let mockChannel: any;
  let mockUnsubscribe: any;
  let queryInterceptor: any;

  beforeEach(() => {
    streamPatcherMock.options = undefined;
    mockUnsubscribe = vi.fn();
    mockChannel = {
      intercept: vi.fn((interceptor) => {
        queryInterceptor = interceptor;
        return mockUnsubscribe;
      }),
      subscribe: vi.fn(),
      unsubscribe: mockUnsubscribe,
      hasSubscribers: false,
    };

    mockNewTracingChannel.mockReturnValue(mockChannel);

    plugin = new ClaudeAgentSDKPlugin();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("enable", () => {
    it("should enable the plugin and subscribe to channels", () => {
      plugin.enable();

      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@anthropic-ai/claude-agent-sdk:query",
      );
      expect(mockChannel.intercept).toHaveBeenCalledTimes(1);
      expect(mockChannel.intercept).toHaveBeenCalledWith(expect.any(Function));
    });

    it("should not subscribe twice if already enabled", () => {
      plugin.enable();
      plugin.enable();

      expect(mockChannel.intercept).toHaveBeenCalledTimes(1);
    });

    it("should store unsubscribe function", () => {
      plugin.enable();

      expect((plugin as any).unsubscribers).toHaveLength(1);
      expect((plugin as any).unsubscribers[0]).toBeInstanceOf(Function);
    });
  });

  describe("disable", () => {
    it("should unsubscribe from all channels", () => {
      plugin.enable();
      plugin.disable();

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
      expect((plugin as any).unsubscribers).toHaveLength(0);
    });

    it("should not unsubscribe if not enabled", () => {
      plugin.disable();

      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });

    it("should clear unsubscribers array", () => {
      plugin.enable();
      plugin.disable();

      expect((plugin as any).unsubscribers).toHaveLength(0);
    });
  });

  describe("channel subscription handlers", () => {
    let handlers: any;

    beforeEach(() => {
      plugin.enable();
      handlers = {
        start: (event: any) =>
          queryInterceptor(
            () => ({
              async *[Symbol.asyncIterator]() {
                // Keep the query span open so tests can drive stream callbacks.
              },
            }),
            event.self,
            event.arguments ?? [],
            {},
          ),
        end: () => undefined,
        error: (event: any) => {
          try {
            queryInterceptor(
              () => {
                throw event.error;
              },
              event.self,
              event.arguments ?? [],
              {},
            );
          } catch {
            // The invocation interceptor preserves the target's exception.
          }
        },
      };
    });

    describe("start handler", () => {
      it("should handle string prompt", () => {
        const event = {
          arguments: [
            {
              prompt: "Hello, world!",
              options: {
                model: "claude-3-5-sonnet-20241022",
                maxTurns: 5,
              },
            },
          ],
        };

        handlers.start(event);

        // Verify no errors thrown
        expect(true).toBe(true);
      });

      it("does not capture API keys in span metadata", () => {
        const event = {
          arguments: [
            {
              prompt: "Hello, world!",
              options: {
                apiKey: "sk-ant-secret",
                apiKeySource: "user",
                model: "claude-3-5-sonnet-20241022",
              },
            },
          ],
        };

        handlers.start(event);

        const span = vi.mocked(startSpan).mock.results[0]?.value;
        expect(span?.log).toHaveBeenCalledWith({
          input: "Hello, world!",
          metadata: {
            model: "claude-3-5-sonnet-20241022",
          },
        });
      });

      it("should handle AsyncIterable prompt", () => {
        const asyncIterable = {
          async *[Symbol.asyncIterator]() {
            yield { type: "message", content: "test" };
          },
        };

        const event = {
          arguments: [
            {
              prompt: asyncIterable,
              options: {
                model: "claude-3-5-sonnet-20241022",
              },
            },
          ],
        };

        handlers.start(event);

        // Verify no errors thrown
        expect(true).toBe(true);
      });

      it("should handle missing options", () => {
        const event = {
          arguments: [
            {
              prompt: "Test",
            },
          ],
        };

        handlers.start(event);

        // Verify no errors thrown
        expect(true).toBe(true);
      });

      it("should handle empty arguments", () => {
        const event = {
          arguments: [],
        };

        handlers.start(event);

        // Verify no errors thrown
        expect(true).toBe(true);
      });

      it("should handle events with null prompt", () => {
        const event = {
          arguments: [
            {
              prompt: null,
              options: {},
            },
          ],
        };

        // Should not throw with null prompt
        expect(() => handlers.start(event)).not.toThrow();
      });
    });

    describe("end handler for sync stream results", () => {
      it("should handle non-streaming result", () => {
        const startEvent = {
          arguments: [
            {
              prompt: "Test",
              options: { model: "claude-3-5-sonnet-20241022" },
            },
          ],
        };
        handlers.start(startEvent);

        const endEvent = {
          ...startEvent,
          result: {
            type: "result",
            message: {
              id: "msg_1",
              content: [{ type: "text", text: "Response" }],
            },
          },
        };

        handlers.end(endEvent);

        // Verify no errors thrown
        expect(true).toBe(true);
      });

      it("should handle end without matching start", () => {
        const endEvent = {
          arguments: [{ prompt: "Test" }],
          result: { type: "result" },
        };

        handlers.end(endEvent);

        // Should not throw
        expect(true).toBe(true);
      });

      it("keeps transcript hooks untouched and logs usage only on the task span when partial messages are disabled", async () => {
        const userSessionStart = vi.fn(async (..._args: unknown[]) => ({}));
        const userSessionStartMatcher = { hooks: [userSessionStart] };
        const startEvent = {
          arguments: [
            {
              prompt: "Test",
              options: {
                hooks: { SessionStart: [userSessionStartMatcher] },
                includePartialMessages: false,
                model: "claude-3-5-sonnet-20241022",
              },
            },
          ],
        };
        handlers.start(startEvent);

        const options = startEvent.arguments[0].options as any;
        expect(options.includePartialMessages).toBe(false);
        expect(options.hooks.SessionStart[0]).toBe(userSessionStartMatcher);
        expect(options.hooks.SessionStart).toHaveLength(1);
        expect(options.hooks.SessionEnd).toBeUndefined();
        expect(options.hooks.UserPromptSubmit).toBeUndefined();

        const stream = {
          async *[Symbol.asyncIterator]() {
            // The patcher is mocked; messages are delivered below.
          },
        };
        handlers.end(Object.assign(startEvent, { result: stream }));

        const assistantMessage = {
          type: "assistant",
          message: {
            content: [{ text: "Response", type: "text" }],
            id: "msg_1",
            model: "claude-3-5-sonnet-20241022",
            role: "assistant",
            usage: {
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 20,
              input_tokens: 10,
              output_tokens: 1,
            },
          },
          parent_tool_use_id: null,
        };
        const originalAssistantMessage = JSON.stringify(assistantMessage);
        await streamPatcherMock.options?.onChunk?.(assistantMessage);
        await streamPatcherMock.options?.onChunk?.({
          num_turns: 1,
          session_id: "session_1",
          type: "result",
          usage: {
            cache_creation: {
              ephemeral_5m_input_tokens: 3,
            },
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 30,
            input_tokens: 20,
            output_tokens: 40,
          },
        });
        await streamPatcherMock.options?.onComplete();

        expect(JSON.stringify(assistantMessage)).toBe(originalAssistantMessage);

        const llmSpanCallIndex = vi
          .mocked(startSpan)
          .mock.calls.findIndex(
            ([args]) =>
              args &&
              typeof args === "object" &&
              "name" in args &&
              args.name === "anthropic.messages.create",
          );
        expect(llmSpanCallIndex).toBeGreaterThan(-1);
        const llmSpan =
          vi.mocked(startSpan).mock.results[llmSpanCallIndex]?.value;
        expect(
          vi
            .mocked(llmSpan!.log)
            .mock.calls.some((call: any[]) => call[0].metrics !== undefined),
        ).toBe(false);
        const taskSpan = vi.mocked(startSpan).mock.results[0]?.value;
        expect(taskSpan?.log).toHaveBeenCalledWith({
          metadata: { num_turns: 1, session_id: "session_1" },
          metrics: {
            completion_tokens: 40,
            prompt_cache_creation_5m_tokens: 3,
            prompt_cache_creation_tokens: 4,
            prompt_cached_tokens: 30,
            prompt_tokens: 54,
            tokens: 94,
          },
        });
      });

      it("omits invalid partial completion usage", async () => {
        const startEvent = {
          arguments: [
            {
              prompt: "Test",
              options: {
                includePartialMessages: true,
                model: "claude-3-5-sonnet-20241022",
              },
            },
          ],
        };
        handlers.start(startEvent);
        expect(startEvent.arguments[0].options.includePartialMessages).toBe(
          true,
        );

        const stream = {
          async *[Symbol.asyncIterator]() {
            // The patcher is mocked; messages are delivered below.
          },
        };
        handlers.end(Object.assign(startEvent, { result: stream }));
        await streamPatcherMock.options?.onChunk?.({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: "msg_missing",
              usage: {
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 20,
                input_tokens: 10,
                output_tokens: 1,
              },
            },
          },
          parent_tool_use_id: null,
        });
        await streamPatcherMock.options?.onChunk?.({
          type: "stream_event",
          event: {
            type: "message_delta",
            usage: { output_tokens: -1 },
          },
          parent_tool_use_id: null,
        });
        await streamPatcherMock.options?.onChunk?.({
          type: "assistant",
          message: {
            content: [{ text: "Response", type: "text" }],
            id: "msg_missing",
            role: "assistant",
            usage: {
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 20,
              input_tokens: 10,
              output_tokens: 1,
            },
          },
          parent_tool_use_id: null,
        });
        await streamPatcherMock.options?.onChunk?.({ type: "result" });
        await expect(
          streamPatcherMock.options?.onComplete(),
        ).resolves.toBeUndefined();

        const llmSpanCallIndex = vi
          .mocked(startSpan)
          .mock.calls.findIndex(
            ([args]) =>
              args &&
              typeof args === "object" &&
              "name" in args &&
              args.name === "anthropic.messages.create",
          );
        const llmSpan =
          vi.mocked(startSpan).mock.results[llmSpanCallIndex]?.value;
        const metricLogs = vi
          .mocked(llmSpan!.log)
          .mock.calls.map((call: any[]) => call[0].metrics)
          .filter(Boolean);
        expect(metricLogs).toEqual([
          {
            prompt_cache_creation_tokens: 3,
            prompt_cached_tokens: 20,
            prompt_tokens: 33,
          },
        ]);
      });

      it("keeps the LLM span without usage when partial messages are disabled", async () => {
        const startEvent = {
          arguments: [
            {
              prompt: "Test",
              options: { model: "claude-3-5-sonnet-20241022" },
            },
          ],
        };
        handlers.start(startEvent);

        const stream = {
          async *[Symbol.asyncIterator]() {
            // The patcher is mocked; messages are delivered below.
          },
        };
        handlers.end(Object.assign(startEvent, { result: stream }));
        await streamPatcherMock.options?.onChunk?.({
          type: "assistant",
          message: {
            content: [{ text: "Response", type: "text" }],
            id: "msg_null_cache",
            model: "claude-3-5-sonnet-20241022",
            role: "assistant",
            // Bedrock, Vertex, and gateway-backed runs report `null` for the
            // cache fields they do not populate.
            usage: {
              cache_creation: null,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              input_tokens: 10,
              output_tokens: 40,
            },
          },
          parent_tool_use_id: null,
        });
        await streamPatcherMock.options?.onChunk?.({ type: "result" });
        await streamPatcherMock.options?.onComplete();

        const llmSpanCallIndex = vi
          .mocked(startSpan)
          .mock.calls.findIndex(
            ([args]) =>
              args &&
              typeof args === "object" &&
              "name" in args &&
              args.name === "anthropic.messages.create",
          );
        expect(llmSpanCallIndex).toBeGreaterThan(-1);
        const llmSpan =
          vi.mocked(startSpan).mock.results[llmSpanCallIndex]?.value;
        expect(llmSpan?.log).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: {
              model: "claude-3-5-sonnet-20241022",
              provider: "anthropic",
            },
            output: [
              {
                content: [{ text: "Response", type: "text" }],
                role: "assistant",
              },
            ],
          }),
        );
        expect(
          vi
            .mocked(llmSpan!.log)
            .mock.calls.some((call: any[]) => call[0].metrics !== undefined),
        ).toBe(false);
      });

      it("layers partial stream usage over the assistant message usage", async () => {
        const startEvent = {
          arguments: [
            {
              prompt: "Test",
              options: {
                includePartialMessages: true,
                model: "claude-3-5-sonnet-20241022",
              },
            },
          ],
        };
        handlers.start(startEvent);

        const stream = {
          async *[Symbol.asyncIterator]() {
            // The patcher is mocked; messages are delivered below.
          },
        };
        handlers.end(Object.assign(startEvent, { result: stream }));
        await streamPatcherMock.options?.onChunk?.({
          type: "stream_event",
          event: {
            type: "message_start",
            // No usable counts here, so the prompt-side totals must come from
            // the assistant message rather than defaulting to zero.
            message: { id: "msg_partial", usage: { input_tokens: null } },
          },
          parent_tool_use_id: null,
        });
        await streamPatcherMock.options?.onChunk?.({
          type: "stream_event",
          event: { type: "message_delta", usage: { output_tokens: 40 } },
          parent_tool_use_id: null,
        });
        await streamPatcherMock.options?.onChunk?.({
          type: "assistant",
          message: {
            content: [{ text: "Response", type: "text" }],
            id: "msg_partial",
            role: "assistant",
            usage: {
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 20,
              input_tokens: 10,
              output_tokens: 40,
            },
          },
          parent_tool_use_id: null,
        });
        await streamPatcherMock.options?.onChunk?.({
          type: "result",
          usage: {
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 20,
            input_tokens: 10,
            output_tokens: 40,
          },
        });
        await streamPatcherMock.options?.onComplete();

        const llmSpanCallIndex = vi
          .mocked(startSpan)
          .mock.calls.findIndex(
            ([args]) =>
              args &&
              typeof args === "object" &&
              "name" in args &&
              args.name === "anthropic.messages.create",
          );
        const llmSpan =
          vi.mocked(startSpan).mock.results[llmSpanCallIndex]?.value;
        expect(llmSpan?.log).toHaveBeenCalledWith(
          expect.objectContaining({
            metrics: {
              completion_tokens: 40,
              prompt_cache_creation_tokens: 3,
              prompt_cached_tokens: 20,
              prompt_tokens: 33,
              tokens: 73,
            },
          }),
        );
        const taskSpan = vi.mocked(startSpan).mock.results[0]?.value;
        expect(
          vi
            .mocked(taskSpan!.log)
            .mock.calls.some((call: any[]) => call[0].metrics !== undefined),
        ).toBe(false);
      });
    });

    describe("error handler", () => {
      it("should handle errors", () => {
        const startEvent = {
          arguments: [
            {
              prompt: "Test",
              options: {},
            },
          ],
        };
        handlers.start(startEvent);

        const errorEvent = {
          ...startEvent,
          error: new Error("Test error"),
        };

        handlers.error(errorEvent);

        // Verify no errors thrown
        expect(true).toBe(true);
      });

      it("should handle error without matching start", () => {
        const errorEvent = {
          arguments: [{ prompt: "Test" }],
          error: new Error("Test error"),
        };

        handlers.error(errorEvent);

        // Should not throw
        expect(true).toBe(true);
      });
    });
  });

  describe("enable/disable lifecycle", () => {
    it("should allow re-enabling after disable", () => {
      plugin.enable();
      plugin.disable();
      plugin.enable();

      expect(mockChannel.intercept).toHaveBeenCalledTimes(2);
    });

    it("should properly clean up on multiple enable/disable cycles", () => {
      plugin.enable();
      plugin.disable();
      plugin.enable();
      plugin.disable();

      expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
      expect((plugin as any).unsubscribers).toHaveLength(0);
    });
  });
});
