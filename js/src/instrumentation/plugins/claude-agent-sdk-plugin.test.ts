import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import { ClaudeAgentSDKPlugin } from "./claude-agent-sdk-plugin";
import iso from "../../isomorph";
import { startSpan } from "../../logger";
import type { ClaudeAgentSDKQueryOptions } from "../../vendor-sdk-types/claude-agent-sdk";
import { patchStreamIfNeeded } from "../core/stream-patcher";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

// Mock the logger module
vi.mock("../../logger", () => ({
  startSpan: vi.fn(() => ({
    log: vi.fn(),
    end: vi.fn(),
    export: vi.fn(() => Promise.resolve({})),
  })),
}));

vi.mock("../core/stream-patcher", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../core/stream-patcher")>();
  return {
    ...actual,
    patchStreamIfNeeded: vi.fn((stream) => stream),
  };
});

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

vi.mock("../../wrappers/anthropic-tokens-util", () => ({
  extractAnthropicCacheTokens: vi.fn((read, creation) => ({
    prompt_cache_read_tokens: read,
    prompt_cache_creation_tokens: creation,
  })),
  finalizeAnthropicTokens: vi.fn((metrics) => ({
    ...metrics,
    tokens: (metrics.prompt_tokens || 0) + (metrics.completion_tokens || 0),
  })),
}));

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
  };
});

describe("ClaudeAgentSDKPlugin", () => {
  let plugin: ClaudeAgentSDKPlugin;
  let mockChannel: any;
  let mockUnsubscribe: any;

  beforeEach(() => {
    mockUnsubscribe = vi.fn();
    mockChannel = {
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
      expect(mockChannel.subscribe).toHaveBeenCalledTimes(1);
      expect(mockChannel.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          start: expect.any(Function),
          end: expect.any(Function),
          error: expect.any(Function),
        }),
      );
    });

    it("should not subscribe twice if already enabled", () => {
      plugin.enable();
      plugin.enable();

      expect(mockChannel.subscribe).toHaveBeenCalledTimes(1);
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
      handlers = mockChannel.subscribe.mock.calls[0][0];
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
      it("creates one LLM span when a tool hook races stream processing", async () => {
        let streamCallbacks: any;
        vi.mocked(patchStreamIfNeeded).mockImplementationOnce(
          (stream, callbacks) => {
            streamCallbacks = callbacks;
            return stream;
          },
        );
        const stream = {
          async *[Symbol.asyncIterator]() {
            return;
          },
        };
        const event: {
          arguments: [
            {
              prompt: string;
              options: ClaudeAgentSDKQueryOptions;
            },
          ];
          result: typeof stream;
        } = {
          arguments: [
            {
              prompt: "Use a tool",
              options: {},
            },
          ],
          result: stream,
        };

        handlers.start(event);
        handlers.end(event);

        let resolveParentExport: (parent: string) => void = () => {};
        const parentExport = new Promise<string>((resolve) => {
          resolveParentExport = resolve;
        });
        const taskSpan = vi.mocked(startSpan).mock.results[0]?.value;
        if (!taskSpan) {
          throw new Error("Expected task span to be created");
        }
        vi.mocked(taskSpan.export).mockReturnValue(parentExport);
        const preToolUse =
          event.arguments[0].options.hooks?.PreToolUse?.at(-1)?.hooks[0];
        if (!preToolUse) {
          throw new Error("Expected PreToolUse hook to be installed");
        }
        streamCallbacks.onChunk({
          message: {
            content: [
              {
                id: "tool-use-1",
                input: {},
                name: "Bash",
                type: "tool_use",
              },
            ],
            id: "message-1",
            model: "claude",
            role: "assistant",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          type: "assistant",
        });
        const preToolUseResult = preToolUse(
          {
            cwd: "/tmp",
            hook_event_name: "PreToolUse",
            session_id: "session-1",
            tool_input: {},
            tool_name: "Bash",
            transcript_path: "/tmp/transcript",
          },
          "tool-use-1",
          { signal: new AbortController().signal },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        resolveParentExport("parent");
        await preToolUseResult;
        await streamCallbacks.onComplete([]);

        const llmSpanCalls = vi
          .mocked(startSpan)
          .mock.calls.filter(
            ([spanArgs]) => spanArgs?.name === "anthropic.messages.create",
          );
        expect(llmSpanCalls).toHaveLength(1);
      });

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

      expect(mockChannel.subscribe).toHaveBeenCalledTimes(2);
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
