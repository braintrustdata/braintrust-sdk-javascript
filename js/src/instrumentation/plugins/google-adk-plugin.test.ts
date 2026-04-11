import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel — must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import { GoogleADKPlugin } from "./google-adk-plugin";
import iso from "../../isomorph";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

// Mock logger
const mockStartSpan = vi.fn(() => ({
  log: vi.fn(),
  end: vi.fn(),
  export: vi.fn(() => Promise.resolve("mock-span-export")),
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: any[]) => mockStartSpan(...args),
  _internalGetGlobalState: vi.fn(() => undefined),
  Attachment: class MockAttachment {
    reference: any;
    constructor(params: any) {
      this.reference = {
        filename: params.filename,
        content_type: params.contentType,
      };
    }
  },
}));

describe("GoogleADKPlugin", () => {
  let plugin: GoogleADKPlugin;
  let mockChannel: any;
  let subscribeSpy: any;
  let unsubscribeSpy: any;

  beforeEach(() => {
    subscribeSpy = vi.fn();
    unsubscribeSpy = vi.fn();
    mockChannel = {
      subscribe: subscribeSpy,
      unsubscribe: unsubscribeSpy,
      hasSubscribers: false,
    };

    mockNewTracingChannel.mockReturnValue(mockChannel);
    mockStartSpan.mockClear();
    plugin = new GoogleADKPlugin();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("enable/disable lifecycle", () => {
    it("should subscribe to channels when enabled", () => {
      plugin.enable();

      // Should subscribe to 3 channels: runner.runAsync, agent.runAsync, tool.runAsync
      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@google/adk:runner.runAsync",
      );
      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@google/adk:agent.runAsync",
      );
      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@google/adk:tool.runAsync",
      );
      expect(subscribeSpy).toHaveBeenCalledTimes(3);
    });

    it("should not subscribe multiple times if enabled twice", () => {
      plugin.enable();
      const firstCallCount = subscribeSpy.mock.calls.length;

      plugin.enable();
      const secondCallCount = subscribeSpy.mock.calls.length;

      expect(firstCallCount).toBe(secondCallCount);
    });

    it("should unsubscribe from channels when disabled", () => {
      plugin.enable();
      plugin.disable();

      expect(unsubscribeSpy).toHaveBeenCalled();
    });

    it("should clear unsubscribers array after disable", () => {
      plugin.enable();
      plugin.disable();

      // Enable again should re-subscribe
      subscribeSpy.mockClear();
      plugin.enable();

      expect(subscribeSpy).toHaveBeenCalledTimes(3);
    });

    it("should not crash when disabled without being enabled", () => {
      expect(() => plugin.disable()).not.toThrow();
    });
  });

  describe("runner.runAsync channel", () => {
    it("should create a TASK span with runner metadata on start", () => {
      plugin.enable();

      // Find the first subscribe call (runner channel)
      const handlers = subscribeSpy.mock.calls[0][0];
      expect(handlers).toHaveProperty("start");
      expect(handlers).toHaveProperty("end");
      expect(handlers).toHaveProperty("error");

      // Simulate a start event
      const event = {
        arguments: [
          {
            userId: "user-123",
            sessionId: "session-456",
            newMessage: {
              role: "user",
              parts: [{ text: "What is the weather?" }],
            },
          },
        ],
      };

      handlers.start(event);

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Google ADK Runner",
          spanAttributes: { type: "task" },
        }),
      );
    });

    it("should handle stream end with async iterable result", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[0][0];

      const event: any = {
        arguments: [
          {
            userId: "user-123",
            sessionId: "session-456",
            newMessage: { role: "user", parts: [{ text: "Hello" }] },
          },
        ],
        result: undefined,
      };

      handlers.start(event);

      // Simulate async iterable result
      const mockAsyncIterable = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn(),
          return: vi.fn(),
          throw: vi.fn(),
        }),
      };

      event.result = mockAsyncIterable;
      handlers.end(event);

      // The stream should be patched — the span shouldn't end immediately
      // (it will end when the stream completes)
    });

    it("should handle error events", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[0][0];

      const event: any = {
        arguments: [
          {
            userId: "user-123",
            sessionId: "session-456",
          },
        ],
        error: new Error("Runner failed"),
      };

      handlers.start(event);

      const span = mockStartSpan.mock.results[0].value;
      handlers.error(event);

      expect(span.log).toHaveBeenCalledWith({ error: "Runner failed" });
      expect(span.end).toHaveBeenCalled();
    });
  });

  describe("agent.runAsync channel", () => {
    it("should create a TASK span with agent metadata on start", () => {
      plugin.enable();

      // Agent channel is the second subscribe call
      const handlers = subscribeSpy.mock.calls[1][0];

      const event = {
        arguments: [
          {
            agent: {
              name: "weather_agent",
              model: "gemini-2.5-flash",
            },
          },
        ],
      };

      handlers.start(event);

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Agent: weather_agent",
          spanAttributes: { type: "task" },
        }),
      );
    });

    it("should handle agent without a name gracefully", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[1][0];

      const event = {
        arguments: [undefined],
      };

      handlers.start(event);

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Google ADK Agent",
        }),
      );
    });
  });

  describe("tool.runAsync channel", () => {
    it("should create a TOOL span on start", () => {
      plugin.enable();

      // Tool channel is the third subscribe call
      const handlers = subscribeSpy.mock.calls[2][0];

      const event: any = {
        arguments: [
          {
            args: { city: "New York" },
            toolContext: {
              functionCallId: "get_weather",
            },
          },
        ],
      };

      handlers.start(event);

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "tool: get_weather",
          spanAttributes: { type: "tool" },
          event: expect.objectContaining({
            input: { city: "New York" },
          }),
        }),
      );
    });

    it("should log output and metrics on asyncEnd", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[2][0];

      const event: any = {
        arguments: [
          {
            args: { city: "New York" },
          },
        ],
        result: { temperature: 72, condition: "sunny" },
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results[0].value;

      handlers.asyncEnd(event);

      expect(span.log).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { temperature: 72, condition: "sunny" },
          metrics: expect.objectContaining({
            start: expect.any(Number),
            end: expect.any(Number),
            duration: expect.any(Number),
          }),
        }),
      );
      expect(span.end).toHaveBeenCalled();
    });

    it("should handle tool execution errors", () => {
      plugin.enable();
      const handlers = subscribeSpy.mock.calls[2][0];

      const event: any = {
        arguments: [{ args: {} }],
        error: new Error("Tool failed"),
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results[0].value;

      handlers.error(event);

      expect(span.log).toHaveBeenCalledWith({ error: "Tool failed" });
      expect(span.end).toHaveBeenCalled();
    });
  });
});
