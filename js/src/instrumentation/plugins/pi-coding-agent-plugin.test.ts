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
    expect(isAutoInstrumentationSuppressed()).toBe(true);
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
    expect(isAutoInstrumentationSuppressed()).toBe(true);
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
    expect(isAutoInstrumentationSuppressed()).toBe(true);
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
