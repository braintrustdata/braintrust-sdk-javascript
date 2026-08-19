import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockCurrentSpanStoreSymbol: MOCK_CURRENT_SPAN_STORE_SYMBOL,
  mockInternalGetGlobalState,
} = vi.hoisted(() => ({
  mockCurrentSpanStoreSymbol: Symbol.for("braintrust.currentSpanStore"),
  mockInternalGetGlobalState: vi.fn(() => undefined),
}));

// Mock iso's newTracingChannel — must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import { registerGoogleADKInstrumentation } from "./google-adk-instrumentation";
import iso from "../../isomorph";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

// Mock logger
const mockStartSpan = vi.fn(() => ({
  log: vi.fn(),
  end: vi.fn(),
  export: vi.fn(() => Promise.resolve("mock-span-export")),
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: any[]) => (mockStartSpan as any)(...args),
  _internalGetGlobalState: (...args: any[]) =>
    (mockInternalGetGlobalState as any)(...args),
  BRAINTRUST_CURRENT_SPAN_STORE: MOCK_CURRENT_SPAN_STORE_SYMBOL,
  withCurrent: (_span: any, callback: () => unknown) => callback(),
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

describe("registerGoogleADKInstrumentation", () => {
  let mockChannel: any;
  let subscribeSpy: any;
  let bindStoreSpy: any;

  beforeEach(() => {
    subscribeSpy = vi.fn();
    bindStoreSpy = vi.fn();
    mockChannel = {
      subscribe: subscribeSpy,
      hasSubscribers: false,
      start: {
        bindStore: bindStoreSpy,
      },
    };

    mockNewTracingChannel.mockReturnValue(mockChannel);
    mockStartSpan.mockClear();
    mockInternalGetGlobalState.mockReset();
    mockInternalGetGlobalState.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("subscribes to channels", () => {
      registerGoogleADKInstrumentation();

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
  });

  describe("runner.runAsync channel", () => {
    it("should create a TASK span with runner metadata on start", () => {
      registerGoogleADKInstrumentation();

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
      registerGoogleADKInstrumentation();
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
      registerGoogleADKInstrumentation();
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

    it("binds the current span store for runner events without creating duplicate spans", () => {
      const currentSpanStore = {};
      const wrapSpanForStore = vi.fn(() => "wrapped-runner-store");
      mockInternalGetGlobalState.mockReturnValue({
        contextManager: {
          [MOCK_CURRENT_SPAN_STORE_SYMBOL]: currentSpanStore,
          wrapSpanForStore,
        },
      } as any);

      registerGoogleADKInstrumentation();

      expect(bindStoreSpy).toHaveBeenNthCalledWith(
        1,
        currentSpanStore,
        expect.any(Function),
      );

      const bindTransform = bindStoreSpy.mock.calls[0][1];
      const handlers = subscribeSpy.mock.calls[0][0];
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

      expect(bindTransform(event)).toBe("wrapped-runner-store");
      expect(wrapSpanForStore).toHaveBeenCalledWith(
        mockStartSpan.mock.results[0].value,
      );

      handlers.start(event);

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        name: "candidate-only usage",
        usageMetadata: [{ candidatesTokenCount: 5 }],
        expectedMetrics: { completion_tokens: 5 },
        absentMetrics: [
          "prompt_tokens",
          "completion_reasoning_tokens",
          "tokens",
        ],
      },
      {
        name: "thought-only usage",
        usageMetadata: [{ thoughtsTokenCount: 7 }],
        expectedMetrics: {
          completion_tokens: 7,
          completion_reasoning_tokens: 7,
        },
        absentMetrics: ["prompt_tokens", "tokens"],
      },
      {
        name: "tool-use-only usage",
        usageMetadata: [{ toolUsePromptTokenCount: 11 }],
        expectedMetrics: { prompt_tokens: 11 },
        absentMetrics: [
          "completion_tokens",
          "completion_reasoning_tokens",
          "tokens",
        ],
      },
      {
        name: "combined usage across events",
        usageMetadata: [
          {
            promptTokenCount: 10,
            toolUsePromptTokenCount: 2,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 1,
            cachedContentTokenCount: 4,
            totalTokenCount: 15,
          },
          {
            promptTokenCount: 5,
            toolUsePromptTokenCount: 1,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 2,
            cachedContentTokenCount: 0,
            totalTokenCount: 11,
          },
        ],
        expectedMetrics: {
          prompt_tokens: 18,
          completion_tokens: 8,
          completion_reasoning_tokens: 3,
          prompt_cached_tokens: 4,
          tokens: 26,
        },
        absentMetrics: [],
      },
      {
        name: "modality-detail usage across events",
        usageMetadata: [
          {
            promptTokensDetails: [
              { modality: "AUDIO", tokenCount: 2 },
              { modality: "TEXT", tokenCount: 10 },
            ],
            candidatesTokensDetails: [
              { modality: "AUDIO", tokenCount: 3 },
              { modality: "IMAGE", tokenCount: 4 },
              { modality: "TEXT", tokenCount: 5 },
            ],
          },
          {
            promptTokensDetails: [{ modality: "AUDIO", tokenCount: 0 }],
            candidatesTokensDetails: [
              { modality: "AUDIO", tokenCount: 2 },
              { modality: "IMAGE", tokenCount: 1 },
            ],
          },
        ],
        expectedMetrics: {
          prompt_audio_tokens: 2,
          completion_audio_tokens: 5,
          completion_image_tokens: 5,
        },
        absentMetrics: ["prompt_tokens", "completion_tokens", "tokens"],
      },
      {
        name: "missing usage",
        usageMetadata: [{}],
        expectedMetrics: {},
        absentMetrics: [
          "completion_audio_tokens",
          "completion_image_tokens",
          "completion_reasoning_tokens",
          "completion_tokens",
          "prompt_audio_tokens",
          "prompt_cached_tokens",
          "prompt_tokens",
          "tokens",
        ],
      },
    ])(
      "normalizes $name",
      async ({ usageMetadata, expectedMetrics, absentMetrics }) => {
        registerGoogleADKInstrumentation();

        const handlers = subscribeSpy.mock.calls[0][0];
        const event: any = {
          arguments: [{ userId: "user-123", sessionId: "session-456" }],
        };

        handlers.start(event);
        const span = mockStartSpan.mock.results.at(-1)?.value as {
          log: ReturnType<typeof vi.fn>;
        };
        event.result = (async function* () {
          for (const usage of usageMetadata) {
            yield { usageMetadata: usage };
          }
        })();
        handlers.end(event);

        for await (const _event of event.result) {
          // Consume the runner stream so the span is finalized.
        }

        const metrics = span.log.mock.calls.at(-1)?.[0].metrics;
        expect(metrics).toMatchObject(expectedMetrics);
        for (const metric of absentMetrics) {
          expect(metrics).not.toHaveProperty(metric);
        }
      },
    );

    it("preserves explicitly reported zero usage", async () => {
      registerGoogleADKInstrumentation();

      const handlers = subscribeSpy.mock.calls[0][0];
      const event: any = {
        arguments: [{ userId: "user-123", sessionId: "session-456" }],
      };

      handlers.start(event);
      const span = mockStartSpan.mock.results.at(-1)?.value as {
        log: ReturnType<typeof vi.fn>;
      };
      event.result = (async function* () {
        yield {
          usageMetadata: {
            cachedContentTokenCount: 0,
            candidatesTokenCount: 0,
            candidatesTokensDetails: [
              { modality: "AUDIO", tokenCount: 0 },
              { modality: "IMAGE", tokenCount: 0 },
            ],
            promptTokenCount: 0,
            promptTokensDetails: [{ modality: "AUDIO", tokenCount: 0 }],
            thoughtsTokenCount: 0,
            toolUsePromptTokenCount: 0,
            totalTokenCount: 0,
          },
        };
      })();
      handlers.end(event);

      for await (const _event of event.result) {
        // Consume the runner stream so the span is finalized.
      }

      expect(span.log.mock.calls.at(-1)?.[0].metrics).toMatchObject({
        completion_audio_tokens: 0,
        completion_image_tokens: 0,
        completion_reasoning_tokens: 0,
        completion_tokens: 0,
        prompt_audio_tokens: 0,
        prompt_cached_tokens: 0,
        prompt_tokens: 0,
        tokens: 0,
      });
    });
  });

  describe("agent.runAsync channel", () => {
    it("should create a TASK span with agent metadata on start", () => {
      registerGoogleADKInstrumentation();

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

    it("uses the invoked agent instance for names when parent context still points at a parent agent", () => {
      registerGoogleADKInstrumentation();

      const handlers = subscribeSpy.mock.calls[1][0];
      const event = {
        arguments: [
          {
            agent: {
              name: "sequential_workflow",
              model: "outer-model",
            },
          },
        ],
        self: {
          name: "greeter",
          model: "gemini-2.5-flash-lite",
        },
      };

      handlers.start(event);

      const span = mockStartSpan.mock.results[0].value;
      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Agent: greeter",
          spanAttributes: { type: "task" },
        }),
      );
      expect(span.log).toHaveBeenCalledWith({
        metadata: {
          provider: "google-adk",
          "google_adk.agent_name": "greeter",
          model: "gemini-2.5-flash-lite",
        },
      });
    });

    it("should handle agent without a name gracefully", () => {
      registerGoogleADKInstrumentation();
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

    it("binds the current span store for agent events without creating duplicate spans", () => {
      const currentSpanStore = {};
      const wrapSpanForStore = vi.fn(() => "wrapped-agent-store");
      mockInternalGetGlobalState.mockReturnValue({
        contextManager: {
          [MOCK_CURRENT_SPAN_STORE_SYMBOL]: currentSpanStore,
          wrapSpanForStore,
        },
      } as any);

      registerGoogleADKInstrumentation();

      expect(bindStoreSpy).toHaveBeenNthCalledWith(
        2,
        currentSpanStore,
        expect.any(Function),
      );

      const bindTransform = bindStoreSpy.mock.calls[1][1];
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

      expect(bindTransform(event)).toBe("wrapped-agent-store");
      expect(wrapSpanForStore).toHaveBeenCalledWith(
        mockStartSpan.mock.results[0].value,
      );

      handlers.start(event);

      expect(mockStartSpan).toHaveBeenCalledTimes(1);
    });

    it("nests auto-instrumented agent spans under the active runner span", () => {
      const runnerSpan = {
        spanId: "runner-span-id",
        rootSpanId: "runner-root-span-id",
        log: vi.fn(),
        end: vi.fn(),
        export: vi.fn(() => Promise.resolve("mock-span-export")),
      };
      const agentSpan = {
        spanId: "agent-span-id",
        rootSpanId: "runner-root-span-id",
        log: vi.fn(),
        end: vi.fn(),
        export: vi.fn(() => Promise.resolve("mock-span-export")),
      };
      mockStartSpan.mockReset();
      mockStartSpan
        .mockImplementationOnce(() => runnerSpan)
        .mockImplementationOnce(() => agentSpan);

      registerGoogleADKInstrumentation();

      const runnerHandlers = subscribeSpy.mock.calls[0][0];
      const agentHandlers = subscribeSpy.mock.calls[1][0];

      runnerHandlers.start({
        arguments: [
          {
            session: {
              id: "session-456",
              userId: "user-123",
            },
            userContent: {
              role: "user",
              parts: [{ text: "What is the weather?" }],
            },
          },
        ],
      });

      agentHandlers.start({
        arguments: [
          {
            session: {
              id: "session-456",
              userId: "user-123",
            },
            agent: {
              name: "weather_agent",
              model: "gemini-2.5-flash",
            },
          },
        ],
      });

      expect(mockStartSpan).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          name: "Agent: weather_agent",
          parentSpanIds: {
            spanId: "runner-span-id",
            rootSpanId: "runner-root-span-id",
          },
        }),
      );
    });
  });

  describe("tool.runAsync channel", () => {
    it("should create a TOOL span on start", () => {
      registerGoogleADKInstrumentation();

      // Tool channel is the third subscribe call
      const handlers = subscribeSpy.mock.calls[2][0];

      const event: any = {
        arguments: [
          {
            args: { city: "New York" },
            toolContext: {
              functionCallId: "call-123",
            },
          },
        ],
        self: {
          name: "get_weather",
        },
      };

      handlers.start(event);

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "tool: get_weather",
          spanAttributes: { type: "tool" },
          event: expect.objectContaining({
            input: { city: "New York" },
            metadata: expect.objectContaining({
              "google_adk.tool_call_id": "call-123",
              "google_adk.tool_name": "get_weather",
            }),
          }),
        }),
      );
    });

    it("should log output and metrics on asyncEnd", () => {
      registerGoogleADKInstrumentation();
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
      registerGoogleADKInstrumentation();
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
