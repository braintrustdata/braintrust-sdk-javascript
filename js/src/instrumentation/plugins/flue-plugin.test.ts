import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCurrentParentSpan, mockFlush, mockStartSpan } = vi.hoisted(() => ({
  mockCurrentParentSpan: { current: undefined as any },
  mockFlush: vi.fn(),
  mockStartSpan: vi.fn(),
}));

const { mockChannelHandlers, mockNewTracingChannel, mockTracingChannel } =
  vi.hoisted(() => {
    const handlers = new Set<any>();
    const tracingChannel = {
      subscribe: vi.fn((handler: any) => {
        handlers.add(handler);
      }),
      unsubscribe: vi.fn((handler: any) => handlers.delete(handler)),
    };

    return {
      mockChannelHandlers: handlers,
      mockNewTracingChannel: vi.fn(() => tracingChannel),
      mockTracingChannel: tracingChannel,
    };
  });

vi.mock("../../logger", () => ({
  flush: (...args: unknown[]) => mockFlush(...args),
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

vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: mockNewTracingChannel,
  },
}));

import { FluePlugin, braintrustFlueObserver } from "./flue-plugin";

type Subscriber = typeof braintrustFlueObserver;

describe("Flue observe instrumentation", () => {
  let spans: Array<{
    args: any;
    end: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    name?: string;
    rootSpanId: string;
    spanId: string;
    spanParents: string[];
  }>;

  beforeEach(() => {
    spans = [];
    mockCurrentParentSpan.current = undefined;
    mockFlush.mockResolvedValue(undefined);
    mockStartSpan.mockImplementation((args: any = {}) => {
      const parentSpan = mockCurrentParentSpan.current;
      const spanId = `span-${spans.length}`;
      const rootSpanId =
        args.parentSpanIds?.rootSpanId ?? parentSpan?.rootSpanId ?? spanId;
      const spanParents = args.parentSpanIds?.spanId
        ? [args.parentSpanIds.spanId]
        : parentSpan?.spanId
          ? [parentSpan.spanId]
          : [];
      const span = {
        args,
        end: vi.fn(),
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
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("braintrust.flue.auto-state")
    ];
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("braintrust.flue.observe-bridge")
    ];
    mockChannelHandlers.clear();
    vi.clearAllMocks();
  });

  it("exports a subscriber that can be passed directly to Flue observe", () => {
    const subscribers: Subscriber[] = [];
    const unsubscribe = vi.fn();
    const observe = vi.fn((subscriber: Subscriber) => {
      subscribers.push(subscriber);
      return unsubscribe;
    });

    const unregister = observe(braintrustFlueObserver);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(braintrustFlueObserver);
    expect(subscribers).toHaveLength(1);

    subscribers[0]?.({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    expect(findSpan("workflow:research")).toBeDefined();

    unregister();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("maps Flue 0.8 observe events into semantic Braintrust spans", () => {
    const emit = observeEvents();
    const usage = flueUsage();
    const startedAt = "2026-05-27T05:12:31.000Z";

    emit(
      {
        instanceId: "instance-1",
        owner: { kind: "workflow", workflowName: "research" },
        payload: {
          metadata: {
            scenario: "flue-instrumentation",
            testRunId: "e2e-run-1",
          },
          topic: "flue",
        },
        runId: "run-1",
        startedAt,
        timestamp: startedAt,
        type: "run_start",
        workflowName: "research",
      },
      { id: "ctx-1", runId: "run-1" },
    );
    emit({
      operationId: "op-1",
      operationKind: "prompt",
      runId: "run-1",
      session: "main",
      timestamp: "2026-05-27T05:12:32.000Z",
      type: "operation_start",
    });
    emit({
      api: "responses",
      input: {
        messages: [{ content: "Find Flue changes", role: "user" }],
        systemPrompt: "Be precise",
        tools: [{ name: "lookup", parameters: {} }],
      },
      model: "claude-test",
      operationId: "op-1",
      provider: "anthropic",
      purpose: "agent",
      reasoning: "medium",
      runId: "run-1",
      timestamp: "2026-05-27T05:12:33.000Z",
      turnId: "turn-1",
      type: "turn_request",
    });
    emit({
      args: { query: "flue instrumentation" },
      operationId: "op-1",
      runId: "run-1",
      timestamp: "2026-05-27T05:12:34.000Z",
      toolCallId: "tool-1",
      toolName: "lookup",
      turnId: "turn-1",
      type: "tool_start",
    });
    emit({
      durationMs: 4,
      isError: false,
      operationId: "op-1",
      result: { ok: true },
      runId: "run-1",
      timestamp: "2026-05-27T05:12:35.000Z",
      toolCallId: "tool-1",
      toolName: "lookup",
      turnId: "turn-1",
      type: "tool_call",
    });
    emit({
      api: "responses",
      durationMs: 12,
      isError: false,
      model: "claude-test",
      operationId: "op-1",
      output: { content: [{ text: "done", type: "text" }], role: "assistant" },
      provider: "anthropic",
      purpose: "agent",
      runId: "run-1",
      stopReason: "stop",
      timestamp: "2026-05-27T05:12:36.000Z",
      turnId: "turn-1",
      type: "turn",
      usage,
    });
    emit({
      agent: "worker",
      operationId: "op-1",
      prompt: "Summarize the source",
      runId: "run-1",
      taskId: "task-1",
      timestamp: "2026-05-27T05:12:37.000Z",
      type: "task_start",
    });
    emit({
      durationMs: 8,
      isError: false,
      result: "task done",
      runId: "run-1",
      taskId: "task-1",
      timestamp: "2026-05-27T05:12:38.000Z",
      type: "task",
    });
    emit({
      estimatedTokens: 200,
      operationId: "op-1",
      reason: "manual",
      runId: "run-1",
      session: "main",
      timestamp: "2026-05-27T05:12:39.000Z",
      type: "compaction_start",
    });
    emit({
      durationMs: 6,
      messagesAfter: 2,
      messagesBefore: 8,
      operationId: "op-1",
      runId: "run-1",
      session: "main",
      timestamp: "2026-05-27T05:12:40.000Z",
      type: "compaction",
      usage,
    });
    emit({
      durationMs: 50,
      isError: false,
      operationId: "op-1",
      operationKind: "prompt",
      result: "operation done",
      runId: "run-1",
      timestamp: "2026-05-27T05:12:41.000Z",
      type: "operation",
      usage,
    });
    emit({
      durationMs: 60,
      isError: false,
      result: { final: true },
      runId: "run-1",
      timestamp: "2026-05-27T05:12:42.000Z",
      type: "run_end",
    });

    const workflowSpan = findSpan("workflow:research");
    const operationSpan = findSpan("flue.prompt");
    const turnSpan = findSpan("llm:claude-test");
    const toolSpan = findSpan("tool:lookup");
    const taskSpan = findSpan("task:worker");
    const compactionSpan = findSpan("compaction:manual");

    expect(workflowSpan?.args).toMatchObject({
      event: {
        input: {
          metadata: {
            scenario: "flue-instrumentation",
            testRunId: "e2e-run-1",
          },
          topic: "flue",
        },
        metadata: {
          "flue.context_id": "ctx-1",
          "flue.workflow_name": "research",
          provider: "flue",
          scenario: "flue-instrumentation",
          testRunId: "e2e-run-1",
        },
      },
      startTime: Date.parse(startedAt) / 1000,
    });
    expect(operationSpan?.spanParents).toEqual([workflowSpan?.spanId]);
    expect(turnSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(toolSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(taskSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(compactionSpan?.spanParents).toEqual([operationSpan?.spanId]);
    expect(turnSpan?.args.event).toMatchObject({
      input: [{ content: "Find Flue changes", role: "user" }],
      metadata: {
        "flue.api": "responses",
        "flue.model": "claude-test",
        "flue.provider": "anthropic",
        "flue.system_prompt": "Be precise",
        "flue.turn_purpose": "agent",
        provider: "anthropic",
        reasoning: "medium",
        tools: [{ name: "lookup", parameters: {} }],
      },
    });
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
        output: {
          content: [{ text: "done", type: "text" }],
          role: "assistant",
        },
      }),
    );
    expect(operationSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ content: "Find Flue changes", role: "user" }],
      }),
    );
    expect(operationSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "flue.usage": usage,
        }),
        metrics: { duration_ms: 50 },
        output: "operation done",
      }),
    );
    expect(operationSpan?.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({ prompt_tokens: 3 }),
      }),
    );
    expect(workflowSpan?.end).toHaveBeenCalledWith({
      endTime: Date.parse("2026-05-27T05:12:42.000Z") / 1000,
    });
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes without awaiting when a run ends", () => {
    const emit = observeEvents();
    const pendingFlush = new Promise<void>(() => {});
    mockFlush.mockReturnValueOnce(pendingFlush);

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    emit({
      durationMs: 1,
      isError: false,
      runId: "run-1",
      timestamp: "2026-05-27T05:12:42.000Z",
      type: "run_end",
    });

    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(findSpan("workflow:research")?.end).toHaveBeenCalledTimes(1);
  });

  it("uses prompt and skill operation text as pending LLM output", () => {
    const emit = observeEvents();
    const usage = flueUsage();

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    emit({
      operationId: "op-1",
      operationKind: "prompt",
      runId: "run-1",
      type: "operation_start",
    });
    emit({
      input: {
        messages: [{ content: "finish", role: "user" }],
      },
      model: "claude-test",
      operationId: "op-1",
      provider: "anthropic",
      purpose: "agent",
      runId: "run-1",
      turnId: "turn-1",
      type: "turn_request",
    });
    emit({
      args: { path: ".agents" },
      operationId: "op-1",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "read",
      turnId: "turn-1",
      type: "tool_start",
    });
    emit({
      durationMs: 50,
      isError: false,
      operationId: "op-1",
      operationKind: "prompt",
      result: { model: { id: "claude-test" }, text: "PROMPT_DONE", usage },
      runId: "run-1",
      timestamp: "2026-05-27T05:12:41.000Z",
      type: "operation",
      usage,
    });

    const operationSpan = findSpan("flue.prompt");
    const turnSpan = findSpan("llm:claude-test");
    const toolSpan = findSpan("tool:read");

    expect(operationSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: "PROMPT_DONE" }),
    );
    expect(turnSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          completion_tokens: 4,
          prompt_tokens: 3,
          tokens: 10,
        }),
        output: "PROMPT_DONE",
      }),
    );
    expect(turnSpan?.end).toHaveBeenCalledWith({
      endTime: Date.parse("2026-05-27T05:12:41.000Z") / 1000,
    });
    expect(toolSpan?.end).toHaveBeenCalledWith({
      endTime: Date.parse("2026-05-27T05:12:41.000Z") / 1000,
    });
  });

  it("closes unfinished operation children when a run ends", () => {
    const emit = observeEvents();

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    emit({
      operationId: "op-compact",
      operationKind: "compact",
      runId: "run-1",
      session: "main",
      type: "operation_start",
    });
    emit({
      estimatedTokens: 200,
      operationId: "op-compact",
      reason: "manual",
      runId: "run-1",
      session: "main",
      type: "compaction_start",
    });
    emit({
      input: {
        messages: [{ content: "summarize", role: "user" }],
      },
      model: "gpt-test",
      operationId: "op-compact",
      provider: "openai",
      purpose: "compaction_prefix",
      runId: "run-1",
      session: "main",
      turnId: "turn-compact",
      type: "turn_request",
    });
    emit({
      durationMs: 60,
      isError: false,
      result: { status: "done" },
      runId: "run-1",
      timestamp: "2026-05-27T05:12:42.000Z",
      type: "run_end",
    });

    const operationSpan = findSpan("flue.compact");
    const compactionSpan = findSpan("compaction:manual");
    const turnSpan = findSpan("llm:gpt-test");

    expect(turnSpan?.end).toHaveBeenCalledWith({
      endTime: Date.parse("2026-05-27T05:12:42.000Z") / 1000,
    });
    expect(compactionSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: { completed: true } }),
    );
    expect(compactionSpan?.end).toHaveBeenCalledWith({
      endTime: Date.parse("2026-05-27T05:12:42.000Z") / 1000,
    });
    expect(operationSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: { completed: true } }),
    );
    expect(operationSpan?.end).toHaveBeenCalledWith({
      endTime: Date.parse("2026-05-27T05:12:42.000Z") / 1000,
    });
  });

  it("creates a root operation span for direct or dispatched agent events", () => {
    const emit = observeEvents();

    emit({
      dispatchId: "dispatch-1",
      instanceId: "instance-1",
      operationId: "op-1",
      operationKind: "prompt",
      session: "main",
      type: "operation_start",
    });

    const operationSpan = findSpan("flue.prompt");
    expect(operationSpan?.spanParents).toEqual([]);
    expect(operationSpan?.args.event.metadata).toMatchObject({
      "flue.dispatch_id": "dispatch-1",
      "flue.instance_id": "instance-1",
      "flue.operation": "prompt",
      "flue.session": "main",
      provider: "flue",
    });
  });

  it("uses task lifecycle spans instead of adding a task operation wrapper", () => {
    const emit = observeEvents();

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    emit({
      operationId: "op-task",
      operationKind: "task",
      runId: "run-1",
      session: "task",
      type: "operation_start",
    });
    emit({
      operationId: "op-task",
      prompt: "Reply with TASK_DONE",
      runId: "run-1",
      taskId: "task-1",
      type: "task_start",
    });
    emit({
      durationMs: 5,
      isError: false,
      operationId: "op-task",
      result: "TASK_DONE",
      runId: "run-1",
      taskId: "task-1",
      type: "task",
    });
    emit({
      durationMs: 6,
      isError: false,
      operationId: "op-task",
      operationKind: "task",
      result: { text: "TASK_DONE" },
      runId: "run-1",
      type: "operation",
    });

    const workflowSpan = findSpan("workflow:research");
    const taskSpans = spans.filter((span) => span.name === "flue.task");

    expect(taskSpans).toHaveLength(1);
    expect(taskSpans[0]?.spanParents).toEqual([workflowSpan?.spanId]);
    expect(taskSpans[0]?.args.event.input).toBe("Reply with TASK_DONE");
    expect(taskSpans[0]?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "TASK_DONE",
      }),
    );
  });

  it("contains observer failures so Flue calls are not affected", () => {
    const emit = observeEvents();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStartSpan.mockImplementationOnce(() => {
      throw new Error("start failed");
    });

    expect(() =>
      emit({
        runId: "run-1",
        type: "run_start",
        workflowName: "broken",
      }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "Error in Flue observe instrumentation:",
      expect.any(Error),
    );
  });

  it("subscribes transformed Flue contexts for auto instrumentation", () => {
    const plugin = new FluePlugin();
    const contextSubscribers: Array<(event: unknown) => unknown> = [];
    const unsubscribeContext = vi.fn();
    const context = {
      id: "ctx-1",
      runId: "run-1",
      subscribeEvent: vi.fn((subscriber: (event: unknown) => unknown) => {
        contextSubscribers.push(subscriber);
        return unsubscribeContext;
      }),
    };

    plugin.enable();
    expect(mockNewTracingChannel).toHaveBeenCalledWith(
      "orchestrion:@flue/runtime:createFlueContext",
    );
    expect(mockTracingChannel.subscribe).toHaveBeenCalledTimes(1);

    emitCreateContextEnd(context);

    expect(context.subscribeEvent).toHaveBeenCalledTimes(1);
    contextSubscribers[0]?.({
      runId: "run-1",
      type: "run_start",
      workflowName: "auto-research",
    });

    expect(
      findSpan("workflow:auto-research")?.args.event.metadata,
    ).toMatchObject({
      "flue.context_id": "ctx-1",
      "flue.context_run_id": "run-1",
    });
    contextSubscribers[0]?.({
      durationMs: 1,
      isError: false,
      result: "done",
      runId: "run-1",
      type: "run_end",
    });
    expect(unsubscribeContext).toHaveBeenCalledTimes(1);

    plugin.disable();

    expect(mockTracingChannel.unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeContext).toHaveBeenCalledTimes(1);
  });

  it("keeps auto instrumentation idempotent across plugin instances", () => {
    const first = new FluePlugin();
    const second = new FluePlugin();
    const contextSubscribers: Array<(event: unknown) => unknown> = [];
    const unsubscribeContext = vi.fn();
    const context = {
      subscribeEvent: vi.fn((subscriber: (event: unknown) => unknown) => {
        contextSubscribers.push(subscriber);
        return unsubscribeContext;
      }),
    };

    first.enable();
    second.enable();
    emitCreateContextEnd(context);
    emitCreateContextEnd(context);

    expect(mockTracingChannel.subscribe).toHaveBeenCalledTimes(1);
    expect(context.subscribeEvent).toHaveBeenCalledTimes(1);

    first.disable();
    expect(mockTracingChannel.unsubscribe).not.toHaveBeenCalled();
    expect(unsubscribeContext).not.toHaveBeenCalled();

    second.disable();
    expect(mockTracingChannel.unsubscribe).toHaveBeenCalledTimes(1);

    contextSubscribers[0]?.({
      runId: "run-after-disable",
      type: "run_start",
      workflowName: "after-disable",
    });
    expect(unsubscribeContext).toHaveBeenCalledTimes(1);
    expect(findSpan("workflow:after-disable")).toBeUndefined();
  });

  it("unsubscribes direct Flue contexts on terminal operation events", () => {
    const plugin = new FluePlugin();
    const contextSubscribers: Array<(event: unknown) => unknown> = [];
    const unsubscribeContext = vi.fn();
    const context = {
      id: "direct-agent-1",
      subscribeEvent: vi.fn((subscriber: (event: unknown) => unknown) => {
        contextSubscribers.push(subscriber);
        return unsubscribeContext;
      }),
    };

    plugin.enable();
    emitCreateContextEnd(context);
    contextSubscribers[0]?.({
      durationMs: 2,
      instanceId: "direct-agent-1",
      isError: false,
      operationId: "op-1",
      operationKind: "prompt",
      result: "done",
      type: "operation",
    });

    expect(unsubscribeContext).toHaveBeenCalledTimes(1);
    expect(findSpan("flue.prompt")).toBeDefined();

    plugin.disable();
  });

  function observeEvents() {
    return (event: unknown, ctx?: unknown) =>
      braintrustFlueObserver(event, ctx);
  }

  function emitCreateContextEnd(result: unknown) {
    for (const handlers of mockChannelHandlers) {
      handlers.end?.({ result });
    }
  }

  function findSpan(name: string) {
    return spans.find((span) => span.name === name);
  }
});

function flueUsage() {
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
