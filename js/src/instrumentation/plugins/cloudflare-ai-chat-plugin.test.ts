import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";
import { invocationController } from "../test-utils/invocation";
vi.mock("../../global-instrumentation-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../global-instrumentation-hooks")
  >()),
  newGlobalInvocationHook: vi.fn(),
}));

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
  default: {},
}));

vi.mock("../../logger", () => ({
  BRAINTRUST_CURRENT_SPAN_STORE: mockCurrentSpanStoreSymbol,
  _internalGetGlobalState: () => mockInternalGetGlobalState(),
  startSpan: (...args: unknown[]) => (mockStartSpan as any)(...args),
  withCurrent: (...args: unknown[]) => (mockWithCurrent as any)(...args),
}));

import {
  INSTRUMENTATION_NAMES,
  INTERNAL_SPAN_INSTRUMENTATION_NAME,
} from "../../span-origin";
import { CloudflareAIChatPlugin } from "./cloudflare-ai-chat-plugin";

const mockNewInvocationHook = newGlobalInvocationHook as ReturnType<
  typeof vi.fn
>;

describe("CloudflareAIChatPlugin", () => {
  let plugin: CloudflareAIChatPlugin;
  let channels: Map<string, ReturnType<typeof createMockChannel>>;

  beforeEach(() => {
    channels = new Map();
    mockNewInvocationHook.mockImplementation((name: string) => {
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

    turnHandlers.begin?.(event);
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
    turnHandlers.resolve?.(event);

    const span = mockStartSpan.mock.results[0].value;
    expect(mockStartSpan).toHaveBeenCalledWith({
      name: "AIChatAgent.onChatMessage",
      spanAttributes: { type: "task" },
      [INTERNAL_SPAN_INSTRUMENTATION_NAME]:
        INSTRUMENTATION_NAMES.CLOUDFLARE_AI_CHAT,
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

  it("correlates response errors and preserves partial output", async () => {
    plugin.enable();
    const turnHandlers = turnChannel().handlers();
    const responseHandlers = responseChannel().handlers();
    const agent = { messages: [], onChatResponse() {} };
    const event = {
      arguments: ["request-error", async () => undefined, undefined],
      self: agent,
    } as any;
    turnHandlers.begin?.(event);
    await event.arguments[1]();

    responseHandlers.begin?.({
      arguments: [
        {
          error: "stream failed",
          message: { parts: [{ text: "partial" }], role: "assistant" },
          requestId: "request-error",
          status: "error",
        },
      ],
      self: agent,
    } as any);
    turnHandlers.resolve?.(event);

    const span = mockStartSpan.mock.results[0].value;
    expect(span.log).toHaveBeenCalledWith({
      error: "stream failed",
      input: [],
      output: { parts: [{ text: "partial" }], role: "assistant" },
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("retains a settled turn until its queued response is observed", async () => {
    plugin.enable();
    const handlers = turnChannel().handlers();
    const agent = {
      messages: [
        {
          id: "user-nested",
          parts: [{ text: "nested", type: "text" }],
          role: "user",
        },
      ],
      onChatResponse(_result?: unknown) {},
    };
    const event = {
      arguments: ["request-nested", async () => undefined, undefined],
      self: agent,
    } as any;

    handlers.begin?.(event);
    await event.arguments[1]();
    handlers.resolve?.(event);

    const span = mockStartSpan.mock.results[0].value;
    expect(span.end).toHaveBeenCalledTimes(1);

    agent.onChatResponse({
      error: "nested failure",
      message: {
        id: "assistant-nested",
        parts: [{ text: "nested response", type: "text" }],
        role: "assistant",
      },
      requestId: "request-nested",
      status: "error",
    });

    expect(span.log).toHaveBeenCalledWith({
      error: "nested failure",
      input: [
        {
          id: "user-nested",
          parts: [{ text: "nested", type: "text" }],
          role: "user",
        },
      ],
      output: {
        id: "assistant-nested",
        parts: [{ text: "nested response", type: "text" }],
        role: "assistant",
      },
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("drops retained turns that never produce a response", () => {
    vi.useFakeTimers();
    try {
      plugin.enable();
      const handlers = turnChannel().handlers();
      const agent = {
        messages: [],
        onChatResponse(_result?: unknown) {},
      };
      const event = {
        arguments: [
          "request-without-response",
          async () => undefined,
          undefined,
        ],
        self: agent,
      } as any;

      handlers.begin?.(event);
      handlers.resolve?.(event);

      const span = mockStartSpan.mock.results[0].value;
      expect(span.end).toHaveBeenCalledTimes(1);
      vi.runOnlyPendingTimers();

      agent.onChatResponse({
        message: {
          id: "assistant-late",
          parts: [{ text: "too late", type: "text" }],
          role: "assistant",
        },
        requestId: "request-without-response",
        status: "completed",
      });
      expect(span.log).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves pre-turn input when a continuation reuses its output id", async () => {
    plugin.enable();
    const handlers = turnChannel().handlers();
    const agent = {
      messages: [
        {
          id: "user-1",
          parts: [{ text: "start", type: "text" }],
          role: "user",
        },
        {
          id: "assistant-1",
          parts: [{ text: "partial", type: "text" }],
          role: "assistant",
        },
      ],
      onChatResponse(_result?: unknown) {},
    };
    const event = {
      arguments: ["request-continuation", async () => undefined, undefined],
      self: agent,
    } as any;

    handlers.begin?.(event);
    await event.arguments[1]();
    agent.messages[1] = {
      id: "assistant-1",
      parts: [{ text: "partial response", type: "text" }],
      role: "assistant",
    };
    agent.onChatResponse({
      continuation: true,
      message: agent.messages[1],
      requestId: "request-continuation",
      status: "completed",
    });
    handlers.resolve?.(event);

    const span = mockStartSpan.mock.results[0].value;
    expect(span.log).toHaveBeenCalledWith({
      input: [
        {
          id: "user-1",
          parts: [{ text: "start", type: "text" }],
          role: "user",
        },
        {
          id: "assistant-1",
          parts: [{ text: "partial", type: "text" }],
          role: "assistant",
        },
      ],
      output: {
        id: "assistant-1",
        parts: [{ text: "partial response", type: "text" }],
        role: "assistant",
      },
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

    handlers.begin?.(outer);
    handlers.begin?.(inner);
    handlers.resolve?.(inner);

    const span = mockStartSpan.mock.results[0].value;
    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    expect(span.end).not.toHaveBeenCalled();

    handlers.resolve?.(outer);
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
    handlers.begin?.(failedEvent);
    failedEvent.error = failure;
    handlers.reject?.(failedEvent);

    const failedSpan = mockStartSpan.mock.results[0].value;
    expect(failedSpan.log).toHaveBeenCalledWith({ error: failure });
    expect(failedSpan.end).toHaveBeenCalledTimes(1);

    const pendingEvent = {
      arguments: ["request-2", async () => undefined, undefined],
      self: { messages: [], onChatResponse() {} },
    } as any;
    handlers.begin?.(pendingEvent);
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
  let interceptor: any;
  let controller: ReturnType<typeof invocationController>;
  return {
    handlers: () => controller,
    intercept: vi.fn((next) => {
      interceptor = next;
      controller = invocationController(next);
      return vi.fn();
    }),
    invoke: (
      target: any,
      receiver: unknown,
      args: unknown[],
      additional: object,
    ) => interceptor(target, receiver, args, additional),
  };
}
