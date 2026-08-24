import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  interceptorsByName,
  mockNewTracingChannel,
  mockRemoveInterceptor,
  mockStartSpan,
} = vi.hoisted(() => ({
  interceptorsByName: new Map<string, any>(),
  mockNewTracingChannel: vi.fn(),
  mockRemoveInterceptor: vi.fn(),
  mockStartSpan: vi.fn(),
}));

vi.mock("../../isomorph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../isomorph")>();
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    ...actual,
    default: {
      ...actual.default,
      newAsyncLocalStorage: <T>() => new AsyncLocalStorage<T>(),
      newTracingChannel: mockNewTracingChannel,
    },
  };
});

vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
}));

import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { PiCodingAgentPlugin } from "./pi-coding-agent-plugin";

const PROMPT_CHANNEL =
  "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt";

type TestSpan = {
  args: any;
  end: ReturnType<typeof vi.fn>;
  export: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  name?: string;
};

describe("PiCodingAgentPlugin", () => {
  let plugins: PiCodingAgentPlugin[];
  let spans: TestSpan[];

  beforeEach(() => {
    plugins = [];
    spans = [];
    interceptorsByName.clear();
    mockNewTracingChannel.mockImplementation((name: string) => ({
      intercept: vi.fn((interceptor) => {
        interceptorsByName.set(name, interceptor);
        return mockRemoveInterceptor;
      }),
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
    for (const plugin of plugins) {
      plugin.disable();
    }
    vi.clearAllMocks();
  });

  it("registers and removes the prompt interceptor", () => {
    const plugin = enablePlugin(plugins);

    expect(interceptorsByName.has(PROMPT_CHANNEL)).toBe(true);
    expect(mockRemoveInterceptor).not.toHaveBeenCalled();

    plugin.disable();

    expect(mockRemoveInterceptor).toHaveBeenCalledTimes(1);
  });

  it("uses interceptor ALS for prompt, LLM, and tool spans", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const finalMessage = makeAssistantMessage("done");
    const originalStreamFn = vi.fn(async () => {
      expect(isAutoInstrumentationSuppressed()).toBe(true);
      return makeStream(finalMessage);
    });
    const agent = makeAgent(originalStreamFn);
    const tool = bashTool();
    agent.state.tools = [tool];
    const session = makeSession(agent);
    const context = {
      systemPrompt: "system",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
      tools: [tool],
    };

    await interceptor(
      async function (this: typeof session) {
        expect(isAutoInstrumentationSuppressed()).toBe(true);
        const stream = await this.agent.streamFn(anthropicModel(), context, {
          apiKey: "secret",
          headers: { authorization: "secret" },
          reasoning: "low",
        });
        await this.agent.emit({
          args: { command: "printf pi_tool_ok" },
          toolCallId: "tool-1",
          toolName: "bash",
          type: "tool_execution_start",
        });
        await tool.execute?.("tool-1", { command: "printf pi_tool_ok" });
        expect(isAutoInstrumentationSuppressed()).toBe(true);
        await this.agent.emit({
          isError: false,
          result: { stdout: "pi_tool_ok" },
          toolCallId: "tool-1",
          toolName: "bash",
          type: "tool_execution_end",
        });
        await stream.result();
        await this.agent.emit({
          message: finalMessage,
          toolResults: [],
          turnIndex: 0,
          type: "turn_end",
        });
      },
      session,
      ["hello", undefined],
      { moduleVersion: "0.79.1" },
    );

    expect(isAutoInstrumentationSuppressed()).toBe(false);
    expect(agent.streamFn).not.toBe(originalStreamFn);
    expect(originalStreamFn).toHaveBeenCalledWith(
      anthropicModel(),
      context,
      expect.objectContaining({ apiKey: "secret" }),
    );

    const taskSpan = findSpan(spans, "AgentSession.prompt");
    const llmSpan = findSpan(spans, "anthropic.messages.create");
    const toolSpan = findSpan(spans, "bash");
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
    expect(toolSpan?.args.event.input).toEqual({
      command: "printf pi_tool_ok",
    });
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: { stdout: "pi_tool_ok" } }),
    );
    const finalTaskLog = taskSpan?.log.mock.calls.at(-1)?.[0];
    expect(finalTaskLog?.metrics).toMatchObject({
      completion_tokens: 3,
      prompt_tokens: 5,
      tokens: 8,
    });
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("isolates overlapping prompts on the same agent without prompt matching", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const originalStreamFn = vi.fn(async () =>
      makeStream(makeAssistantMessage("done")),
    );
    const agent = makeAgent(originalStreamFn);
    const session = makeSession(agent);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();

    const first = interceptor(
      async function (this: typeof session) {
        await firstGate.promise;
        const stream = await this.agent.streamFn(anthropicModel(), {
          messages: [{ role: "user", content: "same prompt" }],
        });
        await stream.result();
      },
      session,
      ["same prompt", undefined],
      {},
    );
    const sharedStreamFn = agent.streamFn;
    const second = interceptor(
      async function (this: typeof session) {
        await secondGate.promise;
        const stream = await this.agent.streamFn(anthropicModel(), {
          messages: [{ role: "user", content: "same prompt" }],
        });
        await stream.result();
      },
      session,
      ["same prompt", undefined],
      {},
    );

    expect(agent.streamFn).toBe(sharedStreamFn);
    secondGate.resolve();
    await second;
    firstGate.resolve();
    await first;

    const llmSpans = spans.filter(
      (span) => span.name === "anthropic.messages.create",
    );
    expect(llmSpans).toHaveLength(2);
    expect(
      spans.filter((span) => span.name === "AgentSession.prompt"),
    ).toHaveLength(2);

    await agent.streamFn(anthropicModel(), {
      messages: [{ role: "user", content: "outside prompt" }],
    });
    expect(
      spans.filter((span) => span.name === "anthropic.messages.create"),
    ).toHaveLength(2);
  });

  it("keeps deferred follow-up prompts open for their ALS-owned turn", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const agent = makeAgent(
      vi.fn(async () => makeStream(makeAssistantMessage("done"))),
    );
    const session = makeSession(agent);
    const turnGate = deferred<void>();
    let backgroundTurn: Promise<void> | undefined;

    await interceptor(
      async function (this: typeof session) {
        backgroundTurn = (async () => {
          await turnGate.promise;
          await this.agent.emit({
            message: makeAssistantMessage("follow-up done"),
            toolResults: [],
            turnIndex: 1,
            type: "turn_end",
          });
        })();
      },
      session,
      ["follow up", { streamingBehavior: "followUp" }],
      {},
    );

    const taskSpan = findSpan(spans, "AgentSession.prompt");
    expect(taskSpan?.end).not.toHaveBeenCalled();

    turnGate.resolve();
    await backgroundTurn;

    expect(taskSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: expect.any(Array) }),
    );
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("preserves full-iterator stream behavior", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const message = makeAssistantMessage("done");
    const { result, stream } = makeIteratorBackedStream([
      { partial: message, type: "start" },
      { message, type: "done" },
    ]);
    const agent = makeAgent(vi.fn(async () => stream));
    const session = makeSession(agent);

    await interceptor(
      async function (this: typeof session) {
        const patchedStream = await this.agent.streamFn(anthropicModel(), {
          messages: [{ role: "user", content: "iterate" }],
        });
        for await (const _event of patchedStream) {
          // Consume through iteration without calling result().
        }
      },
      session,
      ["iterate", undefined],
      {},
    );

    const llmSpan = findSpan(spans, "anthropic.messages.create");
    expect(result).not.toHaveBeenCalled();
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({ tokens: 8 }),
        output: expect.any(Array),
      }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("forwards iterator failures and closes the underlying iterator", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const { iterator, stream } = makeIteratorBackedStream([]);
    iterator.next.mockRejectedValueOnce(new Error("stream next failed"));
    const agent = makeAgent(vi.fn(async () => stream));
    const session = makeSession(agent);

    await expect(
      interceptor(
        async function (this: typeof session) {
          const patchedStream = await this.agent.streamFn(anthropicModel(), {
            messages: [{ role: "user", content: "failure" }],
          });
          await patchedStream[Symbol.asyncIterator]().next();
        },
        session,
        ["failure", undefined],
        {},
      ),
    ).rejects.toThrow("stream next failed");

    const llmSpan = findSpan(spans, "anthropic.messages.create");
    const taskSpan = findSpan(spans, "AgentSession.prompt");
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error: "stream next failed" }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
    expect(taskSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error: "stream next failed" }),
    );
  });

  it("closes active prompt and LLM spans when the target rejects", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const agent = makeAgent(
      vi.fn(async () => makeStream(makeAssistantMessage("unused"))),
    );
    const session = makeSession(agent);

    await expect(
      interceptor(
        async function (this: typeof session) {
          await this.agent.streamFn(anthropicModel(), {
            messages: [{ role: "user", content: "hello" }],
          });
          throw new Error("boom");
        },
        session,
        ["hello", undefined],
        {},
      ),
    ).rejects.toThrow("boom");

    const llmSpan = findSpan(spans, "anthropic.messages.create");
    const taskSpan = findSpan(spans, "AgentSession.prompt");
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error: "boom" }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
    expect(taskSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error: "boom" }),
    );
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("ends in-flight prompts on disable while leaving the safe patch installed", async () => {
    const plugin = enablePlugin(plugins);
    const interceptor = promptInterceptor(plugin);
    const originalStreamFn = vi.fn(async () =>
      makeStream(makeAssistantMessage("done")),
    );
    const agent = makeAgent(originalStreamFn);
    const session = makeSession(agent);
    const targetGate = deferred<void>();

    const result = interceptor(
      async () => {
        await targetGate.promise;
      },
      session,
      ["disable", undefined],
      {},
    );
    const patchedStreamFn = agent.streamFn;

    plugin.disable();

    const taskSpan = findSpan(spans, "AgentSession.prompt");
    expect(agent.streamFn).toBe(patchedStreamFn);
    expect(agent.streamFn).not.toBe(originalStreamFn);
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);

    targetGate.resolve();
    await result;
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);
  });
});

function enablePlugin(plugins: PiCodingAgentPlugin[]): PiCodingAgentPlugin {
  const plugin = new PiCodingAgentPlugin();
  plugins.push(plugin);
  plugin.enable();
  return plugin;
}

function promptInterceptor(_plugin: PiCodingAgentPlugin): any {
  const interceptor = interceptorsByName.get(PROMPT_CHANNEL);
  expect(interceptor).toEqual(expect.any(Function));
  return interceptor;
}

function findSpan(spans: TestSpan[], name: string): TestSpan | undefined {
  return spans.find((span) => span.name === name);
}

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
    execute: vi.fn(async (..._args: unknown[]) => {
      expect(isAutoInstrumentationSuppressed()).toBe(false);
      await Promise.resolve();
      expect(isAutoInstrumentationSuppressed()).toBe(false);
      return { stdout: "pi_tool_ok" };
    }),
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
  const iterator: any = {
    next: vi.fn(async () => {
      const event = pendingEvents.shift();
      return event
        ? { done: false, value: event }
        : { done: true, value: undefined };
    }),
    return: vi.fn(async (value?: unknown) => ({ done: true, value })),
    throw: vi.fn(async (error?: unknown) => {
      throw error;
    }),
  };
  return {
    iterator,
    result,
    stream: {
      [Symbol.asyncIterator]: vi.fn(() => iterator),
      result,
    },
  };
}

function makeAgent(streamFn: any) {
  const listeners = new Set<any>();
  return {
    state: { model: anthropicModel(), tools: [] as any[] },
    streamFn,
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return vi.fn(() => listeners.delete(listener));
    }),
    async emit(event: any) {
      for (const listener of [...listeners]) {
        await listener(event, new AbortController().signal);
      }
    },
  };
}

function makeSession(agent: ReturnType<typeof makeAgent>) {
  return {
    agent,
    getActiveToolNames: () => ["bash"],
    model: anthropicModel(),
    prompt: vi.fn(),
    sessionId: "session-1",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
