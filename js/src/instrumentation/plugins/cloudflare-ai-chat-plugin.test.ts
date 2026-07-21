import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockInternalGetGlobalState,
  mockStartSpan,
  mockWithCurrent,
  mockCurrentSpanStoreSymbol,
} = vi.hoisted(() => ({
  mockCurrentSpanStoreSymbol: Symbol.for("braintrust.currentSpanStore"),
  mockInternalGetGlobalState: vi.fn(() => undefined),
  mockStartSpan: vi.fn(),
  mockWithCurrent: vi.fn((_span: unknown, callback: () => unknown) =>
    callback(),
  ),
}));

vi.mock("../../isomorph", () => ({
  default: { newTracingChannel: vi.fn() },
}));

vi.mock("../../logger", () => ({
  BRAINTRUST_CURRENT_SPAN_STORE: mockCurrentSpanStoreSymbol,
  _internalGetGlobalState: () => mockInternalGetGlobalState(),
  startSpan: (...args: unknown[]) => (mockStartSpan as any)(...args),
  withCurrent: (...args: unknown[]) => (mockWithCurrent as any)(...args),
}));

import iso from "../../isomorph";
import { CloudflareAIChatPlugin } from "./cloudflare-ai-chat-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("CloudflareAIChatPlugin", () => {
  let plugin: CloudflareAIChatPlugin;
  let channels: Map<string, ReturnType<typeof createMockChannel>>;

  beforeEach(() => {
    channels = new Map();
    mockNewTracingChannel.mockImplementation((name: string) => {
      const existing = channels.get(name);
      if (existing) {
        return existing;
      }
      const channel = createMockChannel();
      channels.set(name, channel);
      return channel;
    });
    mockStartSpan.mockImplementation(() => ({
      end: vi.fn(),
      log: vi.fn(),
    }));
    mockInternalGetGlobalState.mockReturnValue(undefined);
    plugin = new CloudflareAIChatPlugin();
  });

  afterEach(() => {
    plugin.disable();
    vi.clearAllMocks();
  });

  it("captures the full successful turn and binds queued work", async () => {
    plugin.enable();
    const turnHandlers = turnChannel().handlers();
    const callback = vi.fn(async () => "callback-result");
    const agent = {
      messages: [
        {
          id: "user-1",
          metadata: { ignored: true },
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        },
      ],
      onChatResponse: vi.fn(),
    };
    const event = {
      arguments: ["request-1", callback, undefined],
      self: agent,
    } as any;

    turnHandlers.start?.(event, "start");
    await event.arguments[1]();
    agent.onChatResponse({
      message: {
        id: "assistant-1",
        metadata: { ignored: true },
        parts: [{ text: "world", type: "text" }],
        role: "assistant",
      },
      requestId: "request-1",
      status: "completed",
    });
    turnHandlers.asyncEnd?.(event, "asyncEnd");

    const span = mockStartSpan.mock.results[0].value;
    expect(mockStartSpan).toHaveBeenCalledWith({
      name: "AIChatAgent.onChatMessage",
      spanAttributes: { type: "task" },
    });
    expect(span.log).toHaveBeenCalledWith({
      input: [
        {
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        },
      ],
    });
    expect(span.log).toHaveBeenCalledWith({
      input: [
        {
          id: "user-1",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        },
      ],
      output: {
        id: "assistant-1",
        parts: [{ text: "world", type: "text" }],
        role: "assistant",
      },
    });
    expect(mockWithCurrent).toHaveBeenCalledWith(span, expect.any(Function));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("correlates response errors and preserves partial output", () => {
    plugin.enable();
    const turnHandlers = turnChannel().handlers();
    const responseHandlers = responseChannel().handlers();
    const agent = { messages: [], onChatResponse() {} };
    const event = {
      arguments: ["request-error", async () => undefined, undefined],
      self: agent,
    } as any;
    turnHandlers.start?.(event, "start");

    responseHandlers.start?.(
      {
        arguments: [
          {
            error: "stream failed",
            message: { parts: [{ text: "partial" }], role: "assistant" },
            requestId: "request-error",
            status: "error",
          },
        ],
        self: agent,
      } as any,
      "start",
    );
    turnHandlers.asyncEnd?.(event, "asyncEnd");

    const span = mockStartSpan.mock.results[0].value;
    expect(span.log).toHaveBeenCalledWith({
      error: "stream failed",
      input: [],
      output: { parts: [{ text: "partial" }], role: "assistant" },
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("deduplicates nested manual and automatic turn events", () => {
    plugin.enable();
    const handlers = turnChannel().handlers();
    const agent = { messages: [], onChatResponse() {} };
    const outer = {
      arguments: ["request-1", async () => undefined, undefined],
      self: agent,
    } as any;
    const inner = {
      arguments: ["request-1", async () => undefined, undefined],
      self: agent,
    } as any;

    handlers.start?.(outer, "start");
    handlers.start?.(inner, "start");
    handlers.asyncEnd?.(inner, "asyncEnd");

    const span = mockStartSpan.mock.results[0].value;
    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    expect(span.end).not.toHaveBeenCalled();

    handlers.asyncEnd?.(outer, "asyncEnd");
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("logs original errors and closes outstanding spans on disable", () => {
    plugin.enable();
    const handlers = turnChannel().handlers();
    const failure = new Error("turn failed");
    const failedEvent = {
      arguments: ["request-1", async () => undefined, undefined],
      self: { messages: [], onChatResponse() {} },
    } as any;
    handlers.start?.(failedEvent, "start");
    failedEvent.error = failure;
    handlers.error?.(failedEvent, "error");

    const failedSpan = mockStartSpan.mock.results[0].value;
    expect(failedSpan.log).toHaveBeenCalledWith({ error: failure });
    expect(failedSpan.end).toHaveBeenCalledTimes(1);

    const pendingEvent = {
      arguments: ["request-2", async () => undefined, undefined],
      self: { messages: [], onChatResponse() {} },
    } as any;
    handlers.start?.(pendingEvent, "start");
    const pendingSpan = mockStartSpan.mock.results[1].value;
    plugin.disable();
    expect(pendingSpan.end).toHaveBeenCalledTimes(1);
  });

  function turnChannel() {
    return channels.get(
      "orchestrion:@cloudflare/ai-chat:AIChatAgent._runExclusiveChatTurn",
    )!;
  }

  function responseChannel() {
    return channels.get(
      "orchestrion:@cloudflare/ai-chat:AIChatAgent.onChatResponse",
    )!;
  }
});

function createMockChannel() {
  const subscribed: any[] = [];
  return {
    handlers: () => subscribed[0],
    hasSubscribers: false,
    start: {
      bindStore: vi.fn(),
      unbindStore: vi.fn(),
    },
    subscribe: vi.fn((handlers) => subscribed.push(handlers)),
    traceSync: vi.fn((callback, event) => {
      subscribed[0]?.start?.(event, "start");
      try {
        const result = callback();
        event.result = result;
        subscribed[0]?.end?.(event, "end");
        return result;
      } catch (error) {
        event.error = error;
        subscribed[0]?.error?.(event, "error");
        throw error;
      }
    }),
    unsubscribe: vi.fn(),
  };
}
