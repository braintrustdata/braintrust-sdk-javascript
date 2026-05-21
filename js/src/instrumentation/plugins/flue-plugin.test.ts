import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCurrentParentSpan, mockStartSpan } = vi.hoisted(() => ({
  mockCurrentParentSpan: { current: undefined as any },
  mockStartSpan: vi.fn(),
}));

vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
  withCurrent: (span: unknown, callback: () => unknown) => {
    const previous = mockCurrentParentSpan.current;
    mockCurrentParentSpan.current = span;
    try {
      return callback();
    } finally {
      mockCurrentParentSpan.current = previous;
    }
  },
}));

import iso from "../../isomorph";
import { FluePlugin } from "./flue-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("FluePlugin", () => {
  let handlersByName: Map<string, any>;
  let spans: Array<{
    end: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    name?: string;
    rootSpanId: string;
    spanId: string;
    spanParents: string[];
  }>;

  beforeEach(() => {
    handlersByName = new Map();
    spans = [];
    mockCurrentParentSpan.current = undefined;
    mockNewTracingChannel.mockImplementation((name: string) => ({
      subscribe: vi.fn((handlers) => handlersByName.set(name, handlers)),
      tracePromise: vi.fn((fn) => fn()),
      traceSync: vi.fn((fn) => fn()),
      unsubscribe: vi.fn(),
    }));
    mockStartSpan.mockImplementation((args: any) => {
      const spanId = `span-${spans.length}`;
      const parentSpan = mockCurrentParentSpan.current;
      const rootSpanId =
        args.parentSpanIds?.rootSpanId ?? parentSpan?.rootSpanId ?? spanId;
      const spanParents = args.parentSpanIds?.spanId
        ? [args.parentSpanIds.spanId]
        : parentSpan?.spanId
          ? [parentSpan.spanId]
          : [];
      const span = {
        end: vi.fn(),
        export: vi.fn(async () => `${args.name}-export-${spans.length}`),
        log: vi.fn(),
        name: args.name,
        rootSpanId,
        spanId,
        spanParents,
      };
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to Flue channels", () => {
    const plugin = new FluePlugin();

    plugin.enable();

    expect(
      handlersByName.has("orchestrion:@flue/runtime:createFlueContext"),
    ).toBe(true);
    expect(
      handlersByName.has("orchestrion:@flue/runtime:Harness.openSession"),
    ).toBe(true);
    expect(handlersByName.has("orchestrion:@flue/runtime:context.event")).toBe(
      true,
    );
    expect(handlersByName.has("orchestrion:@flue/runtime:session.prompt")).toBe(
      true,
    );
    expect(handlersByName.has("orchestrion:@flue/runtime:session.skill")).toBe(
      true,
    );
    expect(handlersByName.has("orchestrion:@flue/runtime:session.task")).toBe(
      true,
    );
    expect(
      handlersByName.has("orchestrion:@flue/runtime:session.compact"),
    ).toBe(true);
  });

  it("patches contexts and sessions returned by auto-instrumented entrypoints", async () => {
    const plugin = new FluePlugin();
    plugin.enable();

    const session = makeSession();
    const harness = { session: vi.fn(async () => session) };
    const ctx = {
      init: vi.fn(async () => harness),
      subscribeEvent: vi.fn(() => vi.fn()),
    };
    handlersByName
      .get("orchestrion:@flue/runtime:createFlueContext")
      .end({ arguments: [{}], result: ctx });

    await ctx.init({ model: "pi/test" });
    const wrappedSession = await harness.session();
    await wrappedSession.prompt("hello");

    expect(ctx.subscribeEvent).toHaveBeenCalledTimes(1);
    await expect(wrappedSession.prompt("hello again")).resolves.toEqual({
      text: "ok",
    });
  });

  it("correlates operation, turn, tool, task, and compaction spans", () => {
    const plugin = new FluePlugin();
    plugin.enable();

    const contextHandlers = handlersByName.get(
      "orchestrion:@flue/runtime:context.event",
    );
    const promptHandlers = handlersByName.get(
      "orchestrion:@flue/runtime:session.prompt",
    );
    const promptEvent = {
      arguments: [
        "Use a tool and delegate work",
        { model: "pi/test", tools: [{ name: "lookup", parameters: {} }] },
      ],
      operation: "prompt",
      session: { name: "main" },
    };

    promptHandlers.start(promptEvent);
    contextHandlers.start({
      arguments: [
        {
          eventIndex: 1,
          operationId: "op_1",
          operationKind: "prompt",
          session: "main",
          type: "operation_start",
        },
      ],
    });
    contextHandlers.start({
      arguments: [{ operationId: "op_1", text: "Looking", type: "text_delta" }],
    });
    contextHandlers.start({
      arguments: [{ operationId: "op_1", type: "thinking_start" }],
    });
    contextHandlers.start({
      arguments: [
        { delta: "Think it ", operationId: "op_1", type: "thinking_delta" },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          content: "Think it through.",
          operationId: "op_1",
          type: "thinking_end",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          args: { query: "braintrust" },
          operationId: "op_1",
          toolCallId: "tool_1",
          toolName: "lookup",
          type: "tool_start",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 3,
          isError: false,
          operationId: "op_1",
          result: "lookup ok",
          toolCallId: "tool_1",
          toolName: "lookup",
          type: "tool_call",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 10,
          isError: false,
          model: "pi/test",
          operationId: "op_1",
          stopReason: "stop",
          type: "turn",
          usage: usage(),
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          operationId: "op_1",
          parentSession: "main",
          prompt: "child prompt",
          taskId: "task_1",
          type: "task_start",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          taskId: "task_1",
          text: "child done",
          type: "text_delta",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 8,
          isError: false,
          model: "pi/test",
          stopReason: "stop",
          taskId: "task_1",
          type: "turn",
          usage: usage(),
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 20,
          isError: false,
          result: "task ok",
          taskId: "task_1",
          type: "task",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          estimatedTokens: 100,
          operationId: "op_1",
          reason: "manual",
          type: "compaction_start",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 4,
          messagesAfter: 2,
          messagesBefore: 8,
          operationId: "op_1",
          type: "compaction",
          usage: usage(),
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 50,
          isError: false,
          operationId: "op_1",
          operationKind: "prompt",
          type: "operation",
          usage: usage(),
        },
      ],
    });
    (promptEvent as any).result = {
      model: { id: "pi/test" },
      text: "done",
      usage: usage(),
    };
    promptHandlers.asyncEnd(promptEvent);

    const operationSpan = spans.find(
      (span) => span.name === "flue.session.prompt",
    );
    const turnSpan = spans.find((span) => span.name === "flue.turn");
    const toolSpan = spans.find((span) => span.name === "tool: lookup");
    const taskSpan = spans.find((span) => span.name === "flue.task");
    const childTurnSpan = spans.filter((span) => span.name === "flue.turn")[1];
    const compactionSpan = spans.find(
      (span) => span.name === "flue.compaction",
    );

    expect(operationSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "Use a tool and delegate work",
        metadata: expect.objectContaining({
          "flue.operation": "prompt",
          "flue.tools_count": 1,
          provider: "flue",
        }),
      }),
    );
    expect(turnSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(toolSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(toolSpan?.spanParents).toEqual(turnSpan?.spanParents);
    expect(toolSpan?.spanParents).not.toContain(turnSpan?.spanId);
    expect(taskSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(childTurnSpan?.spanParents).toEqual([taskSpan?.spanId]);
    expect(compactionSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(turnSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          completion_tokens: 4,
          estimated_cost: 0.01,
          prompt_cache_creation_tokens: 2,
          prompt_cached_tokens: 1,
          prompt_tokens: 3,
          tokens: 10,
        }),
        output: [
          expect.objectContaining({
            message: expect.objectContaining({
              content: "Looking",
              reasoning: "Think it through.",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({ query: "braintrust" }),
                    name: "lookup",
                  },
                  id: "tool_1",
                  type: "function",
                },
              ],
            }),
          }),
        ],
      }),
    );
    expect(operationSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("parents synthetic tool spans as siblings of active turn spans", () => {
    const plugin = new FluePlugin();
    plugin.enable();

    const contextHandlers = handlersByName.get(
      "orchestrion:@flue/runtime:context.event",
    );
    const promptHandlers = handlersByName.get(
      "orchestrion:@flue/runtime:session.prompt",
    );
    const promptEvent = {
      arguments: ["Use a tool", { model: "pi/test" }],
      operation: "prompt",
      session: { name: "main" },
    };

    promptHandlers.start(promptEvent);
    contextHandlers.start({
      arguments: [
        {
          operationId: "op_1",
          operationKind: "prompt",
          session: "main",
          type: "operation_start",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        { operationId: "op_1", text: "Using a tool", type: "text_delta" },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 2,
          isError: false,
          operationId: "op_1",
          result: "lookup ok",
          toolCallId: "tool_1",
          toolName: "lookup",
          type: "tool_call",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 10,
          isError: false,
          model: "pi/test",
          operationId: "op_1",
          stopReason: "toolUse",
          type: "turn",
          usage: usage(),
        },
      ],
    });

    const operationSpan = spans.find(
      (span) => span.name === "flue.session.prompt",
    );
    const turnSpan = spans.find((span) => span.name === "flue.turn");
    const toolSpan = spans.find((span) => span.name === "tool: lookup");

    expect(turnSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(toolSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(toolSpan?.spanParents).toEqual(turnSpan?.spanParents);
    expect(toolSpan?.spanParents).not.toContain(turnSpan?.spanId);
  });

  it("records tool calls when tool_start is the first turn event", () => {
    const plugin = new FluePlugin();
    plugin.enable();

    const contextHandlers = handlersByName.get(
      "orchestrion:@flue/runtime:context.event",
    );
    const promptHandlers = handlersByName.get(
      "orchestrion:@flue/runtime:session.prompt",
    );
    const promptEvent = {
      arguments: ["Use a tool", { model: "pi/test" }],
      operation: "prompt",
      session: { name: "main" },
    };

    promptHandlers.start(promptEvent);
    contextHandlers.start({
      arguments: [
        {
          operationId: "op_1",
          operationKind: "prompt",
          session: "main",
          type: "operation_start",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          args: { query: "braintrust" },
          operationId: "op_1",
          toolCallId: "tool_1",
          toolName: "lookup",
          type: "tool_start",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 2,
          isError: false,
          operationId: "op_1",
          result: "lookup ok",
          toolCallId: "tool_1",
          toolName: "lookup",
          type: "tool_call",
        },
      ],
    });
    contextHandlers.start({
      arguments: [
        {
          durationMs: 10,
          isError: false,
          model: "pi/test",
          operationId: "op_1",
          stopReason: "toolUse",
          type: "turn",
          usage: usage(),
        },
      ],
    });

    const operationSpan = spans.find(
      (span) => span.name === "flue.session.prompt",
    );
    const turnSpan = spans.find((span) => span.name === "flue.turn");
    const toolSpan = spans.find((span) => span.name === "tool: lookup");

    expect(turnSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(toolSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(toolSpan?.spanParents).not.toContain(turnSpan?.spanId);
    expect(turnSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        output: [
          expect.objectContaining({
            message: expect.objectContaining({
              content: "",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({ query: "braintrust" }),
                    name: "lookup",
                  },
                  id: "tool_1",
                  type: "function",
                },
              ],
            }),
          }),
        ],
      }),
    );
  });
});

function makeSession() {
  const promise = Promise.resolve({ text: "ok" });
  const handle = {
    abort: vi.fn(),
    signal: new AbortController().signal,
    then: promise.then.bind(promise),
  };
  return {
    compact: vi.fn(async () => undefined),
    name: "main",
    prompt: vi.fn(() => handle),
    skill: vi.fn(() => handle),
    task: vi.fn(() => handle),
  };
}

function usage() {
  return {
    cacheRead: 1,
    cacheWrite: 2,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      total: 0.01,
    },
    input: 3,
    output: 4,
    totalTokens: 10,
  };
}
