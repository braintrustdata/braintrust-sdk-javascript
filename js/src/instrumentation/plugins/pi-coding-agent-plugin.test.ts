import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBindStore,
  mockNewAsyncLocalStorage,
  mockStartSpan,
  mockUnbindStore,
} = vi.hoisted(() => ({
  mockBindStore: vi.fn(),
  mockNewAsyncLocalStorage: vi.fn(() => {
    let current: unknown;
    return {
      enterWith: vi.fn((store: unknown) => {
        current = store;
      }),
      getStore: vi.fn(() => current),
      run: vi.fn((store: unknown, callback: () => unknown) => {
        const previous = current;
        current = store;
        try {
          return callback();
        } finally {
          current = previous;
        }
      }),
    };
  }),
  mockStartSpan: vi.fn(),
  mockUnbindStore: vi.fn(),
}));

vi.mock("../../isomorph", () => ({
  default: {
    newAsyncLocalStorage: mockNewAsyncLocalStorage,
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
}));

import iso from "../../isomorph";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { PiCodingAgentPlugin } from "./pi-coding-agent-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("PiCodingAgentPlugin", () => {
  let handlersByName: Map<string, any>;
  let spans: Array<{
    args: any;
    end: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    name?: string;
  }>;

  beforeEach(() => {
    handlersByName = new Map();
    spans = [];
    mockNewTracingChannel.mockImplementation((name: string) => ({
      start: {
        bindStore: mockBindStore,
        unbindStore: mockUnbindStore,
      },
      subscribe: vi.fn((handlers) => handlersByName.set(name, handlers)),
      unsubscribe: vi.fn(),
    }));
    mockStartSpan.mockImplementation((args: any) => {
      const span = {
        args,
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

  it("subscribes to AgentSession.prompt", () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    expect(
      handlersByName.has(
        "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
      ),
    ).toBe(true);
  });

  it("binds auto instrumentation suppression while AgentSession.prompt runs", () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    expect(mockBindStore).toHaveBeenCalledTimes(1);

    plugin.disable();

    expect(mockUnbindStore).toHaveBeenCalledTimes(1);
  });

  it("wraps streamFn for exact LLM input and restores it on completion", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const finalMessage = makeAssistantMessage("done");
    const stream = makeStream(finalMessage);
    const originalStreamFn = vi.fn(async () => {
      expect(isAutoInstrumentationSuppressed()).toBe(true);
      return stream;
    });
    const unsubscribe = vi.fn();
    const agent = {
      state: { model: anthropicModel(), tools: [bashTool()] },
      streamFn: originalStreamFn,
      subscribe: vi.fn(() => unsubscribe),
    };
    const session = {
      agent,
      model: anthropicModel(),
      prompt: vi.fn(),
      sessionId: "session-1",
      getActiveToolNames: () => ["bash"],
    };
    const event = {
      arguments: ["hello", undefined],
      moduleVersion: "0.79.1",
      self: session,
    };

    handlers.start(event);
    expect(isAutoInstrumentationSuppressed()).toBe(false);
    expect(agent.streamFn).not.toBe(originalStreamFn);

    const context = {
      systemPrompt: "system",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      tools: [bashTool()],
    };
    const patchedStream = await agent.streamFn(anthropicModel(), context, {
      apiKey: "secret",
      headers: { authorization: "secret" },
      reasoning: "low",
    });
    await patchedStream.result();
    await handlers.asyncEnd(event);
    expect(isAutoInstrumentationSuppressed()).toBe(false);

    const llmSpan = spans.find(
      (span) => span.name === "anthropic.messages.create",
    );
    expect(originalStreamFn).toHaveBeenCalledWith(
      anthropicModel(),
      context,
      expect.objectContaining({ apiKey: "secret" }),
    );
    expect(llmSpan?.args.event.input).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(llmSpan?.args.event.metadata).toMatchObject({
      model: "claude-haiku-4-5",
      provider: "anthropic",
      tools: [
        {
          type: "function",
          function: expect.objectContaining({ name: "bash" }),
        },
      ],
    });
    expect(llmSpan?.args.event.metadata).not.toHaveProperty("apiKey");
    expect(llmSpan?.args.event.metadata).not.toHaveProperty("headers");
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          completion_tokens: 3,
          prompt_tokens: 5,
          tokens: 8,
        }),
        output: expect.any(Array),
      }),
    );
    expect(agent.streamFn).toBe(originalStreamFn);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("creates tool spans from awaited agent events", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    let listener: any;
    const agent = {
      state: { model: anthropicModel() },
      streamFn: vi.fn(),
      subscribe: vi.fn((nextListener) => {
        listener = nextListener;
        return vi.fn();
      }),
    };
    const event = {
      arguments: ["run bash", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };

    handlers.start(event);
    expect(isAutoInstrumentationSuppressed()).toBe(false);
    await listener({
      args: { command: "printf pi_tool_ok" },
      toolCallId: "tool-1",
      toolName: "bash",
      type: "tool_execution_start",
    });
    expect(isAutoInstrumentationSuppressed()).toBe(false);
    await listener({
      isError: false,
      result: { stdout: "pi_tool_ok" },
      toolCallId: "tool-1",
      toolName: "bash",
      type: "tool_execution_end",
    });
    expect(isAutoInstrumentationSuppressed()).toBe(false);
    await handlers.asyncEnd(event);
    expect(isAutoInstrumentationSuppressed()).toBe(false);

    const toolSpan = spans.find((span) => span.name === "bash");
    expect(toolSpan?.args.event.input).toEqual({
      command: "printf pi_tool_ok",
    });
    expect(toolSpan?.args.event.metadata).toMatchObject({
      "gen_ai.tool.call.id": "tool-1",
      "gen_ai.tool.name": "bash",
    });
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { stdout: "pi_tool_ok" },
      }),
    );
    expect(toolSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("does not double-count prompt metrics from LLM and turn usage", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    let listener: any;
    const agent = {
      state: { model: anthropicModel() },
      streamFn: vi.fn(async () => makeStream(makeAssistantMessage("done"))),
      subscribe: vi.fn((nextListener) => {
        listener = nextListener;
        return vi.fn();
      }),
    };
    const event = {
      arguments: ["count metrics", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };

    handlers.start(event);
    const patchedStream = await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "count metrics" }],
    });
    await patchedStream.result();
    await listener({
      message: makeAssistantMessage("done"),
      toolResults: [],
      turnIndex: 0,
      type: "turn_end",
    });
    await handlers.asyncEnd(event);

    const rootSpan = spans.find((span) => span.name === "AgentSession.prompt");
    const finalLog =
      rootSpan?.log.mock.calls[rootSpan.log.mock.calls.length - 1]?.[0];
    expect(finalLog?.metrics).toMatchObject({
      completion_tokens: 3,
      prompt_cache_creation_tokens: 0,
      prompt_cached_tokens: 0,
      prompt_tokens: 5,
      tokens: 8,
    });
  });

  it("keeps one shared streamFn patch for overlapping prompts on the same agent", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const stream = makeStream(makeAssistantMessage("done"));
    const originalStreamFn = vi.fn(async () => stream);
    const agent = {
      state: { model: anthropicModel() },
      streamFn: originalStreamFn,
      subscribe: vi.fn(() => vi.fn()),
    };
    const eventA = {
      arguments: ["first", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };
    const eventB = {
      arguments: ["second", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };

    handlers.start(eventA);
    const sharedWrappedStreamFn = agent.streamFn;
    handlers.start(eventB);

    expect(agent.streamFn).toBe(sharedWrappedStreamFn);

    const patchedStream = await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "second" }],
    });
    await patchedStream.result();

    expect(originalStreamFn).toHaveBeenCalledTimes(1);
    expect(
      spans.filter((span) => span.name === "anthropic.messages.create"),
    ).toHaveLength(1);

    await handlers.asyncEnd(eventB);
    expect(agent.streamFn).toBe(sharedWrappedStreamFn);

    await handlers.asyncEnd(eventA);
    expect(agent.streamFn).toBe(originalStreamFn);
  });

  it("finalizes LLM spans when the Pi stream is consumed through iteration only", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const finalMessage = makeAssistantMessage("done");
    const { result, stream } = makeIteratorBackedStream([
      { partial: finalMessage, type: "start" },
      { message: finalMessage, type: "done" },
    ]);
    const agent = {
      state: { model: anthropicModel() },
      streamFn: vi.fn(async () => stream),
      subscribe: vi.fn(() => vi.fn()),
    };
    const event = {
      arguments: ["iterate", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };

    handlers.start(event);
    const patchedStream = await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "iterate" }],
    });
    for await (const _event of patchedStream) {
      // consume the full iterator without calling result()
    }
    await handlers.asyncEnd(event);

    const llmSpan = spans.find(
      (span) => span.name === "anthropic.messages.create",
    );
    expect(result).not.toHaveBeenCalled();
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          completion_tokens: 3,
          prompt_tokens: 5,
          tokens: 8,
        }),
        output: expect.any(Array),
      }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("forwards Pi stream iterator cancellation to the underlying iterator", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const finalMessage = makeAssistantMessage("done");
    const { iterator, stream } = makeIteratorBackedStream([
      { partial: finalMessage, type: "start" },
    ]);
    const agent = {
      state: { model: anthropicModel() },
      streamFn: vi.fn(async () => stream),
      subscribe: vi.fn(() => vi.fn()),
    };
    const event = {
      arguments: ["cancel", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };

    handlers.start(event);
    const patchedStream = await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "cancel" }],
    });
    const patchedIterator = patchedStream[Symbol.asyncIterator]();

    await patchedIterator.next();
    await patchedIterator.return?.("stopped");
    await handlers.asyncEnd(event);

    const llmSpan = spans.find(
      (span) => span.name === "anthropic.messages.create",
    );
    expect(iterator.return).toHaveBeenCalledWith("stopped");
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("forwards Pi stream iterator throw to the underlying iterator", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const finalMessage = makeAssistantMessage("done");
    const { iterator, stream } = makeIteratorBackedStream([
      { partial: finalMessage, type: "start" },
    ]);
    const agent = {
      state: { model: anthropicModel() },
      streamFn: vi.fn(async () => stream),
      subscribe: vi.fn(() => vi.fn()),
    };
    const event = {
      arguments: ["throw", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };
    const error = new Error("stream aborted");

    handlers.start(event);
    const patchedStream = await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "throw" }],
    });
    const patchedIterator = patchedStream[Symbol.asyncIterator]();

    await patchedIterator.next();
    await expect(patchedIterator.throw?.(error)).rejects.toThrow(
      "stream aborted",
    );
    await handlers.asyncEnd(event);

    const llmSpan = spans.find(
      (span) => span.name === "anthropic.messages.create",
    );
    expect(iterator.throw).toHaveBeenCalledWith(error);
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error: "stream aborted" }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("keeps queued follow-up prompts active until their deferred turn runs", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const subscriptions: Array<{
      active: boolean;
      listener: (event: any, signal: AbortSignal) => unknown;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const originalStreamFn = vi.fn(async () =>
      makeStream(makeAssistantMessage("done")),
    );
    const agent = {
      state: { model: anthropicModel() },
      streamFn: originalStreamFn,
      subscribe: vi.fn((listener) => {
        const subscription = {
          active: true,
          listener,
          unsubscribe: vi.fn(() => {
            subscription.active = false;
          }),
        };
        subscriptions.push(subscription);
        return subscription.unsubscribe;
      }),
    };
    const activeEvent = {
      arguments: ["active prompt", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };
    const queuedEvent = {
      arguments: ["queued prompt", { streamingBehavior: "followUp" as const }],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };
    const emit = async (event: any) => {
      for (const subscription of subscriptions) {
        if (subscription.active) {
          await subscription.listener(event, new AbortController().signal);
        }
      }
    };

    handlers.start(activeEvent);
    const sharedWrappedStreamFn = agent.streamFn;
    const activeStream = await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "active prompt" }],
    });
    await activeStream.result();

    handlers.start(queuedEvent);
    await handlers.asyncEnd(queuedEvent);

    const rootSpans = spans.filter(
      (span) => span.name === "AgentSession.prompt",
    );
    expect(rootSpans[1]?.end).not.toHaveBeenCalled();
    expect(agent.streamFn).toBe(sharedWrappedStreamFn);
    expect(subscriptions[1]?.active).toBe(true);

    await emit({
      message: makeAssistantMessage("active done"),
      toolResults: [],
      turnIndex: 0,
      type: "turn_end",
    });
    await handlers.asyncEnd(activeEvent);

    expect(rootSpans[0]?.end).toHaveBeenCalledTimes(1);
    expect(rootSpans[1]?.end).not.toHaveBeenCalled();
    expect(agent.streamFn).toBe(sharedWrappedStreamFn);

    const queuedStream = await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "queued prompt" }],
    });
    await queuedStream.result();
    await emit({
      args: { command: "printf pi_tool_ok" },
      toolCallId: "tool-queued",
      toolName: "bash",
      type: "tool_execution_start",
    });
    await emit({
      isError: false,
      result: { stdout: "pi_tool_ok" },
      toolCallId: "tool-queued",
      toolName: "bash",
      type: "tool_execution_end",
    });
    await emit({
      message: makeAssistantMessage("queued done"),
      toolResults: [],
      turnIndex: 1,
      type: "turn_end",
    });

    const llmInputs = spans
      .filter((span) => span.name === "anthropic.messages.create")
      .map((span) => span.args.event.input);
    expect(llmInputs).toEqual([
      [{ role: "user", content: "active prompt" }],
      [{ role: "user", content: "queued prompt" }],
    ]);
    expect(spans.filter((span) => span.name === "bash")).toHaveLength(1);
    expect(rootSpans[1]?.end).toHaveBeenCalledTimes(1);
    expect(subscriptions[1]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(agent.streamFn).toBe(originalStreamFn);
  });

  it("restores active prompt patches when the plugin is disabled", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const unsubscribe = vi.fn();
    const originalStreamFn = vi.fn();
    const agent = {
      state: { model: anthropicModel() },
      streamFn: originalStreamFn,
      subscribe: vi.fn(() => unsubscribe),
    };
    const event = {
      arguments: ["disable cleanup", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };

    handlers.start(event);
    expect(agent.streamFn).not.toBe(originalStreamFn);

    plugin.disable();
    await Promise.resolve();

    const rootSpan = spans.find((span) => span.name === "AgentSession.prompt");
    expect(agent.streamFn).toBe(originalStreamFn);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(rootSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("restores streamFn and ends open spans on error", async () => {
    const plugin = new PiCodingAgentPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt",
    );
    const unsubscribe = vi.fn();
    const originalStreamFn = vi.fn();
    const agent = {
      state: { model: anthropicModel() },
      streamFn: originalStreamFn,
      subscribe: vi.fn(() => unsubscribe),
    };
    const event = {
      arguments: ["hello", undefined],
      self: { agent, model: anthropicModel(), prompt: vi.fn() },
    };

    handlers.start(event);
    (event as any).error = new Error("boom");
    await handlers.error(event);

    const rootSpan = spans.find((span) => span.name === "AgentSession.prompt");
    expect(agent.streamFn).toBe(originalStreamFn);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error: "boom" }),
    );
    expect(rootSpan?.end).toHaveBeenCalledTimes(1);
  });
});

function anthropicModel() {
  return {
    api: "anthropic-messages",
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
  };
}

function bashTool() {
  return {
    description: "Run a shell command.",
    name: "bash",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
    },
  };
}

function makeAssistantMessage(text: string) {
  return {
    api: "anthropic-messages",
    content: [{ type: "text", text }],
    model: "claude-haiku-4-5",
    provider: "anthropic",
    role: "assistant",
    stopReason: "stop",
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 5,
      output: 3,
      totalTokens: 8,
    },
  };
}

function makeStream(message: ReturnType<typeof makeAssistantMessage>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { partial: message, type: "start" };
      yield { message, type: "done" };
    },
    result: vi.fn(async () => message),
  };
}

function makeIteratorBackedStream(events: any[]) {
  const pendingEvents = [...events];
  const result = vi.fn(async () => makeAssistantMessage("done"));
  const iterator = {
    next: vi.fn(async () => {
      const event = pendingEvents.shift();
      if (!event) {
        return { done: true, value: undefined };
      }
      return { done: false, value: event };
    }),
    return: vi.fn(async (value?: unknown) => ({ done: true, value })),
    throw: vi.fn(async (error?: unknown) => {
      throw error;
    }),
  };
  const stream = {
    [Symbol.asyncIterator]: vi.fn(() => iterator),
    result,
  };
  return { iterator, result, stream };
}
