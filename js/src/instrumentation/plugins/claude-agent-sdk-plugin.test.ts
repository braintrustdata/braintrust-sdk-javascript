import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import { ClaudeAgentSDKPlugin } from "./claude-agent-sdk-plugin";
import iso from "../../isomorph";

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
