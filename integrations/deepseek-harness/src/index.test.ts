import { beforeEach, describe, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => {
  let nextId = 0;
  const spans: MockSpan[] = [];

  class MockSpan {
    readonly id = `span-${++nextId}`;
    readonly parent?: MockSpan;
    readonly args: Record<PropertyKey, unknown>;
    readonly logs: Record<string, unknown>[] = [];
    ended = false;

    constructor(args: Record<PropertyKey, unknown>, parent?: MockSpan) {
      this.args = args;
      this.parent = parent;
      spans.push(this);
    }

    startSpan(args: Record<PropertyKey, unknown>): MockSpan {
      return new MockSpan(args, this);
    }

    log(event: Record<string, unknown>): void {
      this.logs.push(event);
    }

    end(): number {
      this.ended = true;
      return Date.now() / 1000;
    }
  }

  const logger = {
    startSpan: (args: Record<PropertyKey, unknown>) => new MockSpan(args),
    flush: vi.fn(async () => undefined),
  };

  return {
    logger,
    reset() {
      nextId = 0;
      spans.length = 0;
      logger.flush.mockClear();
    },
    spans,
  };
});

vi.mock("braintrust", () => ({
  initLogger: vi.fn(() => mock.logger),
  NOOP_SPAN: {},
  withCurrent: <R>(_span: unknown, callback: () => R): R => callback(),
}));

import type { Context } from "@deepseek-ai/cordis";
import { apply } from "./index";

type Listener = (...args: any[]) => any;

function createContext() {
  const listeners = new Map<string, Listener>();
  let cleanup: (() => Promise<void>) | undefined;
  const warnings: string[] = [];
  const ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    on(event: string, listener: Listener) {
      listeners.set(event, listener);
    },
    effect(register: () => () => Promise<void>) {
      cleanup = register();
      return () => undefined;
    },
  };
  apply(ctx as unknown as Context);
  return {
    cleanup: () => cleanup?.(),
    listener: (event: string) => {
      const listener = listeners.get(event);
      if (!listener) throw new Error(`Missing listener for ${event}`);
      return listener;
    },
    warnings,
  };
}

function session(id = "session-1", parentSession?: string) {
  return { id, header: { id, parentSession } };
}

function userMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

async function consume(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("DeepSeek Harness plugin", () => {
  beforeEach(() => mock.reset());

  test("creates a separate root trace for each user turn", async () => {
    const harness = createContext();
    const currentSession = session();
    const onSessionEvent = harness.listener("session/event");
    const onLlmStream = harness.listener("llm/stream");
    const onToolExecute = harness.listener("tools/execute");

    onSessionEvent(currentSession, {
      type: "turn/start",
      data: { turn: 1 },
    });
    onSessionEvent(currentSession, {
      type: "user/message",
      data: userMessage("first turn"),
    });

    const chunks = [
      { type: "text-delta", index: 0, text: "hello" },
      { type: "block-end", index: 0, block: { type: "text", text: "hello" } },
      {
        type: "usage",
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 1,
        },
      },
      { type: "finish", reason: { kind: "stop" } },
    ];
    const stream = onLlmStream(
      {
        provider: "replay",
        model: "replay-model",
        system: "Be helpful",
        messages: [userMessage("first turn")],
        sessionId: currentSession.id,
      },
      () =>
        (async function* () {
          yield* chunks;
        })(),
    );
    expect(await consume(stream)).toEqual(chunks);

    const token = Symbol("tool");
    const result = await onToolExecute(
      {
        callId: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
        agent: { session: currentSession },
        token,
      },
      async () => ({
        isError: false,
        value: { text: "contents" },
        content: [{ type: "text", text: "contents" }],
      }),
    );
    expect(result.value).toEqual({ text: "contents" });

    onSessionEvent(currentSession, {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "model" },
        },
      },
    });
    onSessionEvent(currentSession, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });

    onSessionEvent(currentSession, {
      type: "turn/start",
      data: { turn: 2 },
    });
    onSessionEvent(currentSession, {
      type: "user/message",
      data: userMessage("second turn"),
    });
    onSessionEvent(currentSession, {
      type: "turn/end",
      data: { turn: 2, reason: { kind: "completed" } },
    });

    const turns = mock.spans.filter(
      (span) => span.args.name === "deepseek_harness.turn",
    );
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.parent)).toEqual([undefined, undefined]);
    expect(turns.map((turn) => turn.id)).toEqual(["span-1", "span-4"]);
    expect(turns.every((turn) => turn.ended)).toBe(true);
    expect(
      turns[0]?.args[Symbol.for("braintrust.spanInstrumentationName")],
    ).toBe("deepseek-harness");

    const llm = mock.spans.find(
      (span) => span.args.name === "deepseek_harness.step",
    );
    const tool = mock.spans.find((span) => span.args.name === "read_file");
    expect(llm?.parent).toBe(turns[0]);
    expect(tool?.parent).toBe(turns[0]);
    expect(llm?.logs).toContainEqual({
      metrics: {
        tokens: 11,
        prompt_tokens: 8,
        completion_tokens: 3,
        completion_reasoning_tokens: 1,
        prompt_cached_tokens: 2,
        prompt_cache_creation_tokens: 1,
      },
      output: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
    });
    expect(turns[0]?.logs).toContainEqual({
      output: "hello",
      metrics: {
        tokens: 11,
        prompt_tokens: 8,
        completion_tokens: 3,
        completion_reasoning_tokens: 1,
        prompt_cached_tokens: 2,
        prompt_cache_creation_tokens: 1,
      },
      metadata: { "deepseek_harness.stop_reason": "completed" },
    });
  });

  test("nests a child-session turn beneath its delegation tool", async () => {
    const harness = createContext();
    const parent = session("parent");
    const child = session("child", "parent");
    const onSessionEvent = harness.listener("session/event");

    onSessionEvent(parent, { type: "turn/start", data: { turn: 1 } });
    const token = Symbol("delegate");
    await harness.listener("tools/execute")(
      {
        callId: "delegate-1",
        name: "delegate",
        arguments: { prompt: "research" },
        agent: { session: parent },
        token,
      },
      async () => {
        harness.listener("session/created")(child);
        onSessionEvent(child, { type: "turn/start", data: { turn: 1 } });
        onSessionEvent(child, {
          type: "turn/end",
          data: { turn: 1, reason: { kind: "completed" } },
        });
        return { isError: false, value: "done", content: [] };
      },
    );

    const delegation = mock.spans.find((span) => span.args.name === "delegate");
    const childTurn = mock.spans.find(
      (span) =>
        span.args.name === "deepseek_harness.turn" &&
        span.parent === delegation,
    );
    expect(childTurn).toBeDefined();
    expect(childTurn?.ended).toBe(true);
  });

  test("preserves model and tool failures", async () => {
    const harness = createContext();
    const currentSession = session();
    harness.listener("session/event")(currentSession, {
      type: "turn/start",
      data: { turn: 1 },
    });

    const modelError = new Error("model exploded");
    const stream = harness.listener("llm/stream")(
      {
        provider: "replay",
        model: "replay-model",
        messages: [],
        sessionId: currentSession.id,
      },
      () =>
        (async function* () {
          throw modelError;
        })(),
    );
    await expect(consume(stream)).rejects.toBe(modelError);

    const toolError = new Error("tool exploded");
    await expect(
      harness.listener("tools/execute")(
        {
          callId: "call-1",
          name: "broken_tool",
          arguments: {},
          agent: { session: currentSession },
          token: Symbol("broken"),
        },
        async () => {
          throw toolError;
        },
      ),
    ).rejects.toBe(toolError);

    expect(
      mock.spans.find((span) => span.args.name === "deepseek_harness.step")
        ?.logs,
    ).toContainEqual({ error: modelError });
    expect(
      mock.spans.find((span) => span.args.name === "broken_tool")?.logs,
    ).toContainEqual({ error: toolError });
  });

  test("closes unfinished turns and flushes on disposal", async () => {
    const harness = createContext();
    harness.listener("session/event")(session(), {
      type: "turn/start",
      data: { turn: 1 },
    });
    await harness.cleanup();
    expect(mock.spans[0]?.ended).toBe(true);
    expect(mock.logger.flush).toHaveBeenCalledOnce();
  });
});
