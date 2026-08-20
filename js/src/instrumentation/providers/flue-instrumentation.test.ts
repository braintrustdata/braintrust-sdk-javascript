import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDebugLog,
  mockCurrentParentSpan,
  mockCurrentSpanStoreSymbol,
  mockCurrentSpanStore,
  mockFlush,
  mockStartSpan,
} = vi.hoisted(() => {
  const currentParentSpan = { current: undefined as any };
  const currentSpanStoreSymbol = Symbol.for("braintrust.currentSpanStore");
  return {
    mockDebugLog: vi.fn(),
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

vi.mock("../../debug-logger", () => ({
  debugLogger: {
    debug: (...args: unknown[]) => mockDebugLog(...args),
  },
}));

vi.mock("../../logger", () => ({
  BRAINTRUST_CURRENT_SPAN_STORE: mockCurrentSpanStoreSymbol,
  NOOP_SPAN: {},
  flush: (...args: unknown[]) => mockFlush(...args),
  _internalGetGlobalState: () => ({
    contextManager: {
      [mockCurrentSpanStoreSymbol]: mockCurrentSpanStore,
      wrapSpanForStore: (span: unknown) => span,
    },
    idGenerator: {
      getSpanId: () => "root-span-id",
      getTraceId: () => "root-trace-id",
      shareRootSpanId: () => false,
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

import { braintrustFlueInstrumentation } from "./flue-instrumentation";

describe("Flue instrumentation", () => {
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
      Symbol.for("braintrust.flue.observe-bridge")
    ];
    vi.clearAllMocks();
  });

  it("exports a Flue instrumentation factory", async () => {
    const instrumentation = braintrustFlueInstrumentation();
    const instrument = vi.fn((value: typeof instrumentation) => value);

    const registered = instrument(instrumentation);

    expect(instrument).toHaveBeenCalledWith(instrumentation);
    expect(typeof registered.observe).toBe("function");
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
      { eventContext: { id: "ctx-1" } },
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

  it("maps Flue 1 workflow observations into semantic Braintrust spans", () => {
    const emit = observeEvents();
    const usage = flueUsage();
    const startedAt = "2026-05-27T05:12:31.000Z";

    emit(
      {
        instanceId: "instance-1",
        input: {
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
      { id: "ctx-1" },
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
      operationId: "op-1",
      purpose: "agent",
      request: {
        api: "responses",
        input: {
          messages: [{ content: "Find Flue changes", role: "user" }],
          systemPrompt: "Be precise",
          tools: [{ name: "lookup", parameters: {} }],
        },
        providerName: "anthropic",
        reasoningLevel: "medium",
        requestedModel: "claude-test",
      },
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
      type: "tool",
    });
    emit({
      durationMs: 12,
      isError: false,
      operationId: "op-1",
      purpose: "agent",
      request: {
        api: "responses",
        providerName: "anthropic",
        requestedModel: "claude-test",
      },
      response: {
        output: {
          content: [{ text: "done", type: "text" }],
          role: "assistant",
        },
        finishReason: "stop",
        usage,
      },
      runId: "run-1",
      timestamp: "2026-05-27T05:12:36.000Z",
      turnId: "turn-1",
      type: "turn",
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
    const turnSpan = findSpan("flue.turn");
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
    expect(operationSpan?.spanParents).toEqual([]);
    expect(operationSpan?.rootSpanId).not.toBe(workflowSpan?.rootSpanId);
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

  it("maps released Flue 2.0 observations and retains the final agent output", () => {
    const emit = observeEvents();
    const usage = flueUsage();

    emit({
      agentName: "ResearchAgent",
      conversationId: "conversation-1",
      instanceId: "instance-1",
      operationId: "op-1",
      operationKind: "prompt",
      submissionId: "submission-1",
      type: "operation_start",
      v: 3,
    });
    emit({
      agentName: "ResearchAgent",
      conversationId: "conversation-1",
      instanceId: "instance-1",
      operationId: "op-1",
      purpose: "agent",
      request: {
        api: "faux-stream",
        input: {
          messages: [{ content: "Research Flue 2", role: "user" }],
        },
        providerId: "test-provider",
        reasoningLevel: "medium",
        requestedModel: "instrumented",
      },
      submissionId: "submission-1",
      turnId: "turn-1",
      type: "turn_request",
      v: 3,
    });
    emit({
      args: { query: "Flue 2" },
      operationId: "op-1",
      toolCallId: "tool-1",
      toolName: "lookup",
      turnId: "turn-1",
      type: "tool_start",
      v: 3,
    });
    emit({
      effectiveResult: { version: 2 },
      isError: false,
      operationId: "op-1",
      result: { output: { version: 2 } },
      toolCallId: "tool-1",
      toolName: "lookup",
      turnId: "turn-1",
      type: "tool",
      v: 3,
    });
    emit({
      durationMs: 12,
      isError: false,
      operationId: "op-1",
      purpose: "agent",
      request: {
        api: "faux-stream",
        providerId: "test-provider",
        requestedModel: "instrumented",
      },
      response: {
        finishReason: "stop",
        output: {
          content: [{ text: "PROMPT_DONE", type: "text" }],
          role: "assistant",
        },
        responseModel: "instrumented",
        usage,
      },
      turnId: "turn-1",
      type: "turn",
      v: 3,
    });
    emit({
      agentInput: { text: "Research Flue 2" },
      agentName: "ResearchAgent",
      conversationId: "conversation-1",
      durationMs: 50,
      instanceId: "instance-1",
      isError: false,
      operationId: "op-1",
      operationKind: "prompt",
      submissionId: "submission-1",
      type: "operation",
      v: 3,
    });

    const operationSpan = findSpan("flue.prompt");
    const turnSpan = findSpan("flue.turn");
    const toolSpan = findSpan("tool:lookup");

    expect(operationSpan?.args.event.metadata).toMatchObject({
      "flue.agent_name": "ResearchAgent",
      "flue.conversation_id": "conversation-1",
      "flue.submission_id": "submission-1",
    });
    expect(operationSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: "PROMPT_DONE" }),
    );
    expect(turnSpan?.args.event).toMatchObject({
      metadata: {
        "flue.api": "faux-stream",
        "flue.model": "instrumented",
        "flue.provider": "test-provider",
        model: "instrumented",
        provider: "test-provider",
        reasoning: "medium",
      },
    });
    expect(turnSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "flue.stop_reason": "stop",
        }),
      }),
    );
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ output: { version: 2 } }),
    );
  });

  it("creates a user-turn trace with incremental LLM inputs", () => {
    const emit = observeEvents();
    const previousUser = { content: "Earlier request", role: "user" };
    const previousAssistant = { content: "Earlier answer", role: "assistant" };
    const currentUser = { content: "Research Flue", role: "user" };
    const toolCall = {
      content: [{ id: "tool-1", name: "lookup", type: "toolCall" }],
      role: "assistant",
    };
    const toolResult = {
      content: [{ text: "Flue result", type: "text" }],
      role: "toolResult",
      toolCallId: "tool-1",
    };

    emit({
      input: { metadata: { scenario: "flue-instrumentation" } },
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
      operationId: "op-1",
      purpose: "agent",
      request: {
        input: {
          messages: [previousUser, previousAssistant, currentUser],
          systemPrompt: "Be precise",
          tools: [{ name: "lookup" }],
        },
      },
      runId: "run-1",
      turnId: "turn-1",
      type: "turn_request",
    });
    emit({
      operationId: "op-1",
      purpose: "agent",
      response: { output: toolCall },
      runId: "run-1",
      turnId: "turn-1",
      type: "turn",
    });
    emit({
      operationId: "op-1",
      purpose: "agent",
      request: {
        input: {
          messages: [
            previousUser,
            previousAssistant,
            currentUser,
            toolCall,
            toolResult,
          ],
          systemPrompt: "Be precise",
          tools: [{ name: "lookup" }],
        },
      },
      runId: "run-1",
      turnId: "turn-1",
      type: "turn_request",
    });
    emit({
      operationId: "op-1",
      purpose: "agent",
      response: { output: { content: "done", role: "assistant" } },
      runId: "run-1",
      turnId: "turn-1",
      type: "turn",
    });
    emit({
      operationId: "op-1",
      purpose: "agent",
      request: {
        input: {
          messages: [currentUser],
          systemPrompt: "Use compacted context",
          tools: [{ name: "search" }],
        },
      },
      runId: "run-1",
      turnId: "turn-1",
      type: "turn_request",
    });

    const workflowSpan = findSpan("workflow:research");
    const operationSpan = findSpan("flue.prompt");
    const turnSpans = spans.filter((span) => span.name === "flue.turn");

    expect(operationSpan?.spanParents).toEqual([]);
    expect(operationSpan?.rootSpanId).not.toBe(workflowSpan?.rootSpanId);
    expect(operationSpan?.args.event.metadata).toMatchObject({
      scenario: "flue-instrumentation",
    });
    expect(operationSpan?.log).toHaveBeenCalledWith({ input: [currentUser] });
    expect(turnSpans).toHaveLength(3);
    expect(turnSpans[0]?.args.event).toMatchObject({
      input: [previousUser, previousAssistant, currentUser],
      metadata: {
        "flue.input_mode": "full",
        "flue.system_prompt": "Be precise",
        tools: [{ name: "lookup" }],
      },
    });
    expect(turnSpans[1]?.args.event).toMatchObject({
      input: [toolCall, toolResult],
      metadata: {
        "flue.input_message_offset": 3,
        "flue.input_mode": "delta",
      },
    });
    expect(turnSpans[1]?.args.event.metadata).not.toHaveProperty(
      "flue.system_prompt",
    );
    expect(turnSpans[1]?.args.event.metadata).not.toHaveProperty("tools");
    expect(turnSpans[2]?.args.event).toMatchObject({
      input: [currentUser],
      metadata: {
        "flue.input_mode": "reset",
        "flue.system_prompt": "Use compacted context",
        tools: [{ name: "search" }],
      },
    });
    expect(mockFlush).not.toHaveBeenCalled();
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
      operationId: "op-1",
      purpose: "agent",
      request: {
        input: {
          messages: [{ content: "finish", role: "user" }],
        },
        providerName: "anthropic",
        requestedModel: "claude-test",
      },
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
    const turnSpan = findSpan("flue.turn");
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
      operationId: "op-compact",
      purpose: "compaction_prefix",
      request: {
        input: {
          messages: [{ content: "summarize", role: "user" }],
        },
        providerName: "openai",
        requestedModel: "gpt-test",
      },
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
    const turnSpan = findSpan("flue.turn");

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
      operationId: "op-task-prompt",
      operationKind: "prompt",
      runId: "run-1",
      session: "task:task-1",
      taskId: "task-1",
      type: "operation_start",
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
    const nestedPromptSpan = findSpan("flue.prompt");

    expect(taskSpans).toHaveLength(1);
    expect(taskSpans[0]?.spanParents).toEqual([workflowSpan?.spanId]);
    expect(nestedPromptSpan?.spanParents).toEqual([taskSpans[0]?.spanId]);
    expect(taskSpans[0]?.args.event.input).toBe("Reply with TASK_DONE");
    expect(taskSpans[0]?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "TASK_DONE",
      }),
    );
  });

  it("contains observer failures so Flue calls are not affected", () => {
    const emit = observeEvents();
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
    expect(mockDebugLog).toHaveBeenCalledWith(
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
      type: "tool",
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
      { id: "ctx-1" },
    );
    const workflowSpan = findSpan("workflow:research");
    const appSpan = await braintrustFlueInstrumentation().interceptor(
      {
        phase: "start",
        runId: "run-1",
        startedAt: "2026-05-27T05:12:31.000Z",
        type: "workflow",
        workflowName: "research",
      },
      { eventContext: { id: "ctx-1" } },
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
    const appSpan = await braintrustFlueInstrumentation().interceptor(
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
      operationId: "op-prompt",
      purpose: "agent",
      request: {
        input: { messages: [{ content: "hello", role: "user" }] },
        providerName: "anthropic",
        requestedModel: "claude-test",
      },
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
    const turnSpan = findSpan("flue.turn");
    const taskSpan = findSpan("flue.task");
    const agentAppSpan = await braintrustFlueInstrumentation().interceptor(
      { operationId: "op-prompt", operationKind: "prompt", type: "agent" },
      { operationId: "op-prompt", runId: "run-1" },
      async () => mockStartSpan({ name: "app.agent-phase" }),
    );
    const modelAppSpan = await braintrustFlueInstrumentation().interceptor(
      { turnId: "turn-1", type: "model" },
      { operationId: "op-prompt", runId: "run-1", turnId: "turn-1" },
      async () => mockStartSpan({ name: "app.model-phase" }),
    );
    const taskAppSpan = await braintrustFlueInstrumentation().interceptor(
      { taskId: "task-1", type: "task" },
      { operationId: "op-prompt", runId: "run-1", taskId: "task-1" },
      async () => mockStartSpan({ name: "app.task-phase" }),
    );

    expect(agentAppSpan.spanParents).toEqual([operationSpan?.spanId]);
    expect(modelAppSpan.spanParents).toEqual([turnSpan?.spanId]);
    expect(taskAppSpan.spanParents).toEqual([taskSpan?.spanId]);
    expect(mockCurrentParentSpan.current).toBeUndefined();
  });

  function observeEvents() {
    return (event: unknown, ctx?: unknown) =>
      braintrustFlueInstrumentation().observe(event, ctx);
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
