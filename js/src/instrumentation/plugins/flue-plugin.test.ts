import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCurrentParentSpan,
  mockCurrentSpanStoreSymbol,
  mockCurrentSpanStore,
  mockFlush,
  mockStartSpan,
} = vi.hoisted(() => {
  const currentParentSpan = { current: undefined as any };
  const currentSpanStoreSymbol = Symbol.for("braintrust.currentSpanStore");
  return {
    mockCurrentParentSpan: currentParentSpan,
    mockCurrentSpanStoreSymbol: currentSpanStoreSymbol,
    mockCurrentSpanStore: {
      getStore: vi.fn(() => currentParentSpan.current),
      run: vi.fn((span: unknown, callback: () => unknown) => {
        const previous = currentParentSpan.current;
        currentParentSpan.current = span;
        try {
          return callback();
        } finally {
          currentParentSpan.current = previous;
        }
      }),
    },
    mockFlush: vi.fn(),
    mockStartSpan: vi.fn(),
  };
});

const { mockNewTracingChannel, mockTracingChannels } = vi.hoisted(() => {
  const tracingChannels = new Map<string, any>();

  function tracingChannel(name: string) {
    const existing = tracingChannels.get(name);
    if (existing) {
      return existing;
    }

    const handlers = new Set<any>();
    const stores = new Map<any, (message: any) => unknown>();
    const channel = {
      __handlers: handlers,
      __stores: stores,
      start: {
        bindStore: vi.fn(
          (store: unknown, transform: (message: any) => unknown) => {
            stores.set(store, transform);
          },
        ),
        unbindStore: vi.fn((store: unknown) => stores.delete(store)),
      },
      subscribe: vi.fn((handler: any) => {
        handlers.add(handler);
      }),
      unsubscribe: vi.fn((handler: any) => handlers.delete(handler)),
    };
    tracingChannels.set(name, channel);
    return channel;
  }

  return {
    mockNewTracingChannel: vi.fn((name: string) => tracingChannel(name)),
    mockTracingChannels: tracingChannels,
  };
});

vi.mock("../../logger", () => ({
  BRAINTRUST_CURRENT_SPAN_STORE: mockCurrentSpanStoreSymbol,
  flush: (...args: unknown[]) => mockFlush(...args),
  _internalGetGlobalState: () => ({
    contextManager: {
      [mockCurrentSpanStoreSymbol]: mockCurrentSpanStore,
      wrapSpanForStore: (span: unknown) => span,
    },
  }),
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

import {
  FluePlugin,
  braintrustFlueInstrumentation,
  braintrustFlueObserver,
} from "./flue-plugin";

type Subscriber = typeof braintrustFlueObserver;

const CREATE_CONTEXT_CHANNEL_NAME =
  "orchestrion:@flue/runtime:createFlueContext";

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
    mockCurrentSpanStore.getStore.mockClear();
    mockCurrentSpanStore.run.mockClear();
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
    for (const channel of mockTracingChannels.values()) {
      channel.__handlers.clear();
      channel.__stores.clear();
    }
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

  it("exports a Flue 1.0 instrumentation factory", async () => {
    const instrumentation = braintrustFlueInstrumentation();
    const instrument = vi.fn((value: typeof instrumentation) => value);

    const registered = instrument(instrumentation);

    expect(instrument).toHaveBeenCalledWith(instrumentation);
    expect(registered.observe).toBe(braintrustFlueObserver);
    expect(registered.key).toBe(Symbol.for("braintrust.flue.instrumentation"));
    expect(typeof registered.interceptor).toBe("function");
    expect(() => registered.dispose()).not.toThrow();

    const appSpan = await registered.interceptor(
      {
        phase: "start",
        runId: "run-1",
        startedAt: "2026-05-27T05:12:31.000Z",
        type: "workflow",
        workflowName: "research",
      },
      { eventContext: { id: "ctx-1", runId: "run-1" } },
      async () => mockStartSpan({ name: "app.phase" }),
    );
    const workflowSpan = findSpan("workflow:research");

    expect(workflowSpan).toBeDefined();
    expect(appSpan.spanParents).toEqual([workflowSpan?.spanId]);
    expect(mockCurrentSpanStore.run).toHaveBeenCalledWith(
      workflowSpan,
      expect.any(Function),
    );
    expect("enterWith" in mockCurrentSpanStore).toBe(false);
  });

  it("keeps the legacy observer compatible with Flue 1.0 instrumentation", async () => {
    expect(braintrustFlueObserver.observe).toBe(braintrustFlueObserver);
    expect(braintrustFlueObserver.key).toBe(
      Symbol.for("braintrust.flue.instrumentation"),
    );
    expect(typeof braintrustFlueObserver.interceptor).toBe("function");
    expect(() => braintrustFlueObserver.dispose()).not.toThrow();

    const appSpan = await braintrustFlueObserver.interceptor(
      {
        phase: "start",
        runId: "run-1",
        startedAt: "2026-05-27T05:12:31.000Z",
        type: "workflow",
        workflowName: "research",
      },
      { eventContext: { id: "ctx-1", runId: "run-1" } },
      async () => mockStartSpan({ name: "app.phase" }),
    );
    const workflowSpan = findSpan("workflow:research");

    expect(workflowSpan).toBeDefined();
    expect(appSpan.spanParents).toEqual([workflowSpan?.spanId]);
    expect(mockCurrentSpanStore.run).toHaveBeenCalledWith(
      workflowSpan,
      expect.any(Function),
    );
    expect("enterWith" in mockCurrentSpanStore).toBe(false);
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

  it("maps Flue 1.0 observations into semantic Braintrust spans", () => {
    const emit = observeEvents();
    const usage = flueUsage();

    emit(
      {
        eventIndex: 0,
        input: {
          metadata: { scenario: "flue-v1" },
          topic: "native instrumentation",
        },
        runId: "run-1",
        timestamp: "2026-05-27T05:12:31.000Z",
        type: "run_start",
        v: 3,
        workflowName: "research",
      },
      { id: "ctx-1", runId: "run-1" },
    );
    emit({
      eventIndex: 1,
      operationId: "op-1",
      operationKind: "prompt",
      runId: "run-1",
      type: "operation_start",
      v: 3,
    });
    emit({
      eventIndex: 2,
      operationId: "op-1",
      purpose: "agent",
      request: {
        api: "responses",
        input: {
          messages: [{ content: "Find native hooks", role: "user" }],
          systemPrompt: "Be exact",
          tools: [{ name: "lookup" }],
        },
        model: "claude-test",
        providerId: "anthropic",
        providerName: "anthropic",
        reasoning: "medium",
      },
      runId: "run-1",
      turnId: "turn-1",
      type: "turn_request",
      v: 3,
    });
    emit({
      args: { query: "native flue instrumentation" },
      eventIndex: 3,
      operationId: "op-1",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "lookup",
      turnId: "turn-1",
      type: "tool_start",
      v: 3,
    });
    emit({
      durationMs: 4,
      eventIndex: 4,
      isError: false,
      operationId: "op-1",
      output: { ok: true },
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "lookup",
      turnId: "turn-1",
      type: "tool",
      v: 3,
    });
    emit({
      durationMs: 12,
      eventIndex: 5,
      isError: false,
      operationId: "op-1",
      purpose: "agent",
      request: {
        api: "responses",
        model: "claude-test",
        providerId: "anthropic",
        providerName: "anthropic",
      },
      response: {
        output: { content: [{ text: "done", type: "text" }] },
        stopReason: "stop",
        usage,
      },
      runId: "run-1",
      turnId: "turn-1",
      type: "turn",
      v: 3,
    });
    emit({
      durationMs: 50,
      eventIndex: 6,
      isError: false,
      operationId: "op-1",
      operationKind: "prompt",
      result: { text: "PROMPT_DONE", usage },
      runId: "run-1",
      type: "operation",
      usage,
      v: 3,
    });

    const workflowSpan = findSpan("workflow:research");
    const turnSpan = findSpan("llm:claude-test");
    const toolSpan = findSpan("tool:lookup");
    const operationSpan = findSpan("flue.prompt");

    expect(workflowSpan?.args.event.input).toMatchObject({
      metadata: { scenario: "flue-v1" },
      topic: "native instrumentation",
    });
    expect(turnSpan?.args.event).toMatchObject({
      input: [{ content: "Find native hooks", role: "user" }],
      metadata: {
        "flue.api": "responses",
        "flue.model": "claude-test",
        "flue.provider": "anthropic",
        "flue.system_prompt": "Be exact",
        provider: "anthropic",
        reasoning: "medium",
        tools: [{ name: "lookup" }],
      },
    });
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: { ok: true } }),
    );
    expect(turnSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "flue.stop_reason": "stop",
        }),
        output: { content: [{ text: "done", type: "text" }] },
      }),
    );
    expect(operationSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: "PROMPT_DONE" }),
    );
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

  it("does not need enterWith or ambient current in the observer-only workflow path", () => {
    const emit = observeEvents();

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });

    expect("enterWith" in mockCurrentSpanStore).toBe(false);
    expect(findSpan("workflow:research")).toBeDefined();
    expect(mockCurrentParentSpan.current).toBeUndefined();

    const appSpan = mockStartSpan({ name: "app.phase" });
    expect(appSpan.spanParents).toEqual([]);

    emit({
      durationMs: 1,
      isError: false,
      result: "done",
      runId: "run-1",
      type: "run_end",
    });

    expect(mockCurrentParentSpan.current).toBeUndefined();
  });

  it("does not make tool spans ambient current in the observer-only path", () => {
    const emit = observeEvents();

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    emit({
      operationId: "op-prompt",
      operationKind: "prompt",
      runId: "run-1",
      type: "operation_start",
    });
    emit({
      args: { query: "flue" },
      operationId: "op-prompt",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "lookup",
      type: "tool_start",
    });

    expect(findSpan("tool:lookup")).toBeDefined();
    expect(mockCurrentParentSpan.current).toBeUndefined();

    const appSpan = mockStartSpan({ name: "app.tool-phase" });
    expect(appSpan.spanParents).toEqual([]);

    emit({
      durationMs: 1,
      isError: false,
      operationId: "op-prompt",
      result: "done",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "lookup",
      type: "tool_call",
    });

    expect(mockCurrentParentSpan.current).toBeUndefined();
  });

  it("makes the workflow span current during Flue workflow execution", async () => {
    const emit = observeEvents();

    emit(
      {
        input: { topic: "flue" },
        runId: "run-1",
        type: "run_start",
        workflowName: "research",
      },
      { id: "ctx-1", runId: "run-1" },
    );
    const workflowSpan = findSpan("workflow:research");
    const appSpan = await braintrustFlueObserver.interceptor(
      {
        phase: "start",
        runId: "run-1",
        startedAt: "2026-05-27T05:12:31.000Z",
        type: "workflow",
        workflowName: "research",
      },
      { eventContext: { id: "ctx-1", runId: "run-1" } },
      async () => mockStartSpan({ name: "app.phase" }),
    );

    expect(appSpan.spanParents).toEqual([workflowSpan?.spanId]);
    expect(mockCurrentParentSpan.current).toBeUndefined();
    expect(mockCurrentSpanStore.run).toHaveBeenCalledWith(
      workflowSpan,
      expect.any(Function),
    );
  });

  it("makes Flue tool spans current during tool execution", async () => {
    const emit = observeEvents();

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    emit({
      operationId: "op-prompt",
      operationKind: "prompt",
      runId: "run-1",
      type: "operation_start",
    });
    emit({
      args: { query: "flue" },
      operationId: "op-prompt",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "lookup",
      type: "tool_start",
    });

    const toolSpan = findSpan("tool:lookup");
    const appSpan = await braintrustFlueObserver.interceptor(
      { toolCallId: "tool-1", toolName: "lookup", type: "tool" },
      { operationId: "op-prompt", runId: "run-1" },
      async () => mockStartSpan({ name: "app.tool-phase" }),
    );

    expect(appSpan.spanParents).toEqual([toolSpan?.spanId]);
    expect(mockCurrentParentSpan.current).toBeUndefined();
    expect(mockCurrentSpanStore.run).toHaveBeenCalledWith(
      toolSpan,
      expect.any(Function),
    );
  });

  it("makes agent, model, and task spans current during native execution", async () => {
    const emit = observeEvents();

    emit({
      runId: "run-1",
      type: "run_start",
      workflowName: "research",
    });
    emit({
      operationId: "op-prompt",
      operationKind: "prompt",
      runId: "run-1",
      type: "operation_start",
    });
    emit({
      input: { messages: [{ content: "hello", role: "user" }] },
      model: "claude-test",
      operationId: "op-prompt",
      provider: "anthropic",
      purpose: "agent",
      runId: "run-1",
      turnId: "turn-1",
      type: "turn_request",
    });
    emit({
      operationId: "op-prompt",
      prompt: "Reply with TASK_DONE",
      runId: "run-1",
      taskId: "task-1",
      type: "task_start",
    });

    const operationSpan = findSpan("flue.prompt");
    const turnSpan = findSpan("llm:claude-test");
    const taskSpan = findSpan("flue.task");
    const agentAppSpan = await braintrustFlueObserver.interceptor(
      { operationId: "op-prompt", operationKind: "prompt", type: "agent" },
      { operationId: "op-prompt", runId: "run-1" },
      async () => mockStartSpan({ name: "app.agent-phase" }),
    );
    const modelAppSpan = await braintrustFlueObserver.interceptor(
      { turnId: "turn-1", type: "model" },
      { operationId: "op-prompt", runId: "run-1", turnId: "turn-1" },
      async () => mockStartSpan({ name: "app.model-phase" }),
    );
    const taskAppSpan = await braintrustFlueObserver.interceptor(
      { taskId: "task-1", type: "task" },
      { operationId: "op-prompt", runId: "run-1", taskId: "task-1" },
      async () => mockStartSpan({ name: "app.task-phase" }),
    );

    expect(agentAppSpan.spanParents).toEqual([operationSpan?.spanId]);
    expect(modelAppSpan.spanParents).toEqual([turnSpan?.spanId]);
    expect(taskAppSpan.spanParents).toEqual([taskSpan?.spanId]);
    expect(mockCurrentParentSpan.current).toBeUndefined();
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
      CREATE_CONTEXT_CHANNEL_NAME,
    );
    expect(
      tracingChannel(CREATE_CONTEXT_CHANNEL_NAME).subscribe,
    ).toHaveBeenCalledTimes(1);

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

    expect(
      tracingChannel(CREATE_CONTEXT_CHANNEL_NAME).unsubscribe,
    ).toHaveBeenCalledTimes(1);
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

    expect(
      tracingChannel(CREATE_CONTEXT_CHANNEL_NAME).subscribe,
    ).toHaveBeenCalledTimes(1);
    expect(context.subscribeEvent).toHaveBeenCalledTimes(1);

    first.disable();
    expect(
      tracingChannel(CREATE_CONTEXT_CHANNEL_NAME).unsubscribe,
    ).not.toHaveBeenCalled();
    expect(unsubscribeContext).not.toHaveBeenCalled();

    second.disable();
    expect(
      tracingChannel(CREATE_CONTEXT_CHANNEL_NAME).unsubscribe,
    ).toHaveBeenCalledTimes(1);

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
    for (const handlers of tracingChannel(CREATE_CONTEXT_CHANNEL_NAME)
      .__handlers) {
      handlers.end?.({ result });
    }
  }

  function tracingChannel(channelName: string) {
    const channel = mockTracingChannels.get(channelName);
    if (!channel) {
      throw new Error(`Missing mocked tracing channel: ${channelName}`);
    }
    return channel;
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
