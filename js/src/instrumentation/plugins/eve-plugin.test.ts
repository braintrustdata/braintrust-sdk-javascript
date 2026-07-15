import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash } from "node:crypto";
import * as braintrustExports from "../../exports";
import { configureNode } from "../../node/config";
import {
  _exportsForTestingOnly,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import * as instrumentationExports from "../index";
import { braintrustEveHook, braintrustEveInstrumentation } from "./eve-plugin";
import type {
  EveHandleMessageStreamEvent,
  EveHookContext,
} from "../../vendor-sdk-types/eve";
import { mergeRowBatch } from "../../../util/index";

function deterministicEveIdForTest(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("\0"))
    .digest("hex")
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

function createFakeDefineState() {
  const values = new Map<string, unknown>();
  return {
    defineState<T>(name: string, initial: () => T) {
      return {
        get: () => (values.has(name) ? (values.get(name) as T) : initial()),
        update: (fn: (current: T) => T) => {
          values.set(
            name,
            fn(values.has(name) ? (values.get(name) as T) : initial()),
          );
        },
      };
    },
    values,
  };
}

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("braintrustEveHook", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let defineState: ReturnType<typeof createFakeDefineState>["defineState"];

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    defineState = createFakeDefineState().defineState;
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "eve-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("returns an Eve hook definition", () => {
    const hook = braintrustEveHook({ defineState });

    expect(Object.keys(hook)).toEqual(["events"]);
    expect(typeof hook.events?.["*"]).toBe("function");
  });

  it("returns an Eve instrumentation definition", () => {
    const setup = vi.fn();
    const instrumentation = braintrustEveInstrumentation({
      defineState,
      setup,
    });

    expect(instrumentation).toMatchObject({
      recordInputs: false,
      recordOutputs: false,
      setup,
    });
    expect(typeof instrumentation.events?.["step.started"]).toBe("function");
  });

  it("requires Eve's defineState API", () => {
    expect(() => braintrustEveHook(undefined as never)).toThrow();
    expect(() => braintrustEveInstrumentation(undefined as never)).toThrow();
  });

  it("exports Eve APIs from root and instrumentation entrypoints", () => {
    expect(braintrustExports.braintrustEveHook).toBe(braintrustEveHook);
    expect(braintrustExports.braintrustEveInstrumentation).toBe(
      braintrustEveInstrumentation,
    );
    expect(instrumentationExports.braintrustEveHook).toBe(braintrustEveHook);
    expect(instrumentationExports.braintrustEveInstrumentation).toBe(
      braintrustEveInstrumentation,
    );
  });

  it("captures Eve instrumentation model input on the matching LLM step", async () => {
    const fakeEve = createFakeDefineState();
    defineState = fakeEve.defineState;
    const instrumentation = braintrustEveInstrumentation({ defineState });
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      session: { id: "session-captured-input" },
    };
    const emit = (event: EveHandleMessageStreamEvent) => wildcard?.(event, ctx);
    const modelInput = {
      instructions: "Answer with the relevant Eve instrumentation detail.",
      messages: [
        {
          content: "What should Braintrust capture?",
          role: "user",
        },
      ],
    };

    await emit({
      data: { sequence: 0, turnId: "turn-captured-input" },
      type: "turn.started",
    });
    instrumentation.events?.["step.started"]?.({
      modelInput,
      session: { id: "session-captured-input" },
      step: { index: 0 },
      turn: { id: "turn-captured-input", sequence: 0 },
    });
    await emit({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-captured-input" },
      type: "step.started",
    });
    await emit({
      data: {
        finishReason: "stop",
        message: "Capture the model input.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-captured-input",
      },
      type: "message.completed",
    });
    await emit({
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-captured-input",
      },
      type: "step.completed",
    });
    await emit({
      data: { sequence: 0, turnId: "turn-captured-input" },
      type: "turn.completed",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const step = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );
    expect(step?.input).toEqual([
      {
        content: "Answer with the relevant Eve instrumentation detail.",
        role: "system",
      },
      {
        content: "What should Braintrust capture?",
        role: "user",
      },
    ]);
    expect(fakeEve.values.get("braintrust.eve.tracing")).toMatchObject({
      llmInputs: [],
    });
  });

  it("skips missing or malformed Eve instrumentation state without throwing", async () => {
    const instrumentation = braintrustEveInstrumentation({ defineState });
    expect(() =>
      instrumentation.events?.["step.started"]?.({ bad: true } as never),
    ).not.toThrow();

    const fakeEve = createFakeDefineState();
    defineState = fakeEve.defineState;
    fakeEve.values.set("braintrust.eve.tracing", {
      llmInputs: [{ input: { content: "not an array" }, key: "bad" }],
    });
    expect(() =>
      instrumentation.events?.["step.started"]?.({
        modelInput: {
          messages: [{ content: "hello", role: "user" }],
        },
        session: { id: "session-malformed-state" },
        step: { index: 0 },
        turn: { id: "turn-malformed-state" },
      }),
    ).not.toThrow();

    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    const ctx: EveHookContext = { session: { id: "session-no-state" } };
    await wildcard?.(
      {
        data: { sequence: 0, turnId: "turn-no-state" },
        type: "turn.started",
      },
      ctx,
    );
    await wildcard?.(
      {
        data: { sequence: 0, stepIndex: 0, turnId: "turn-no-state" },
        type: "step.started",
      },
      ctx,
    );
    await wildcard?.(
      {
        data: {
          finishReason: "stop",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-no-state",
        },
        type: "step.completed",
      },
      ctx,
    );
    await wildcard?.(
      {
        data: { sequence: 0, turnId: "turn-no-state" },
        type: "turn.completed",
      },
      ctx,
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const step = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );
    expect(step?.input).toBeUndefined();
  });

  it("bounds pre-existing durable trace state", async () => {
    const fakeEve = createFakeDefineState();
    const oversizedEntryCount = 10_001;
    fakeEve.values.set("braintrust.eve.tracing", {
      llmInputs: [],
      metadata: {},
      spanReferences: Array.from(
        { length: oversizedEntryCount },
        (_, index) => ({
          exported: `exported-${index}`,
          rootSpanId: `root-${index}`,
          rowId: `row-${index}`,
          spanId: `span-${index}`,
        }),
      ),
      stepStarts: Array.from({ length: oversizedEntryCount }, (_, index) => ({
        open: false,
        ordinal: index,
        stepIndex: index,
        turnId: `turn-${index}`,
      })),
    });
    const wildcard = braintrustEveHook({
      defineState: fakeEve.defineState,
    }).events?.["*"];

    await wildcard?.(
      {
        data: {
          runtime: {
            agentId: "agent-bounded-state",
            eveVersion: "0.20.0",
            modelId: "openai/gpt-5.4-mini",
          },
        },
        type: "session.started",
      },
      { session: { id: "session-bounded-state" } },
    );

    const state = fakeEve.values.get("braintrust.eve.tracing") as {
      spanReferences: unknown[];
      stepStarts: unknown[];
    };
    expect(state.spanReferences).toHaveLength(10_000);
    expect(state.stepStarts).toHaveLength(10_000);
  });

  it("does not emit a span for session lifecycle metadata alone", async () => {
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];

    await wildcard?.(
      {
        data: {
          runtime: {
            agentId: "agent-session-only",
            eveVersion: "0.20.0",
            modelId: "openai/gpt-5.4-mini",
          },
        },
        type: "session.started",
      },
      { session: { id: "session-only" } },
    );

    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("records a flat Eve turn with session model metadata", async () => {
    const wildcard = braintrustEveHook({
      defineState,
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      },
    }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      session: { id: "session-flat-tree" },
    };
    const emit = (event: EveHandleMessageStreamEvent) => wildcard?.(event, ctx);
    const expectedModelMetadata = {
      model: "braintrust-eve-mock",
      provider: "eve-mock",
    };

    await emit({
      data: {
        runtime: {
          agentId: "agent-id",
          agentName: "eve-test-agent",
          eveVersion: "0.20.0",
          modelId: "eve-mock/braintrust-eve-mock",
        },
      },
      meta: { at: "2026-01-01T00:00:00.000Z" },
      type: "session.started",
    });
    await emit({
      data: { sequence: 0, turnId: "turn-flat-tree" },
      meta: { at: "2026-01-01T00:00:00.010Z" },
      type: "turn.started",
    });
    await emit({
      data: {
        message: "Search then read",
        sequence: 0,
        turnId: "turn-flat-tree",
      },
      meta: { at: "2026-01-01T00:00:00.020Z" },
      type: "message.received",
    });
    await emit({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-flat-tree" },
      meta: { at: "2026-01-01T00:00:00.030Z" },
      type: "step.started",
    });
    await emit({
      data: {
        actions: [
          {
            callId: "call-search",
            input: { query: "Eve instrumentation" },
            kind: "tool-call",
            toolName: "search",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-flat-tree",
      },
      meta: { at: "2026-01-01T00:00:00.040Z" },
      type: "actions.requested",
    });
    await emit({
      data: {
        error: undefined,
        result: {
          callId: "call-search",
          kind: "tool-result",
          output: { hits: ["eve.dev/docs"] },
          toolName: "search",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-flat-tree",
      },
      meta: { at: "2026-01-01T00:00:00.050Z" },
      type: "action.result",
    });
    await emit({
      data: {
        finishReason: "tool-calls",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-flat-tree",
        usage: {
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          costUsd: 0.001,
          inputTokens: 10,
          outputTokens: 5,
        },
      },
      meta: { at: "2026-01-01T00:00:00.060Z" },
      type: "step.completed",
    });
    await emit({
      data: { sequence: 0, stepIndex: 1, turnId: "turn-flat-tree" },
      meta: { at: "2026-01-01T00:00:00.070Z" },
      type: "step.started",
    });
    await emit({
      data: {
        finishReason: "stop",
        message: "Here is the Eve instrumentation guide.",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-flat-tree",
      },
      meta: { at: "2026-01-01T00:00:00.080Z" },
      type: "message.completed",
    });
    await emit({
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-flat-tree",
        usage: {
          inputTokens: 20,
          outputTokens: 8,
        },
      },
      meta: { at: "2026-01-01T00:00:00.090Z" },
      type: "step.completed",
    });
    await emit({
      data: { sequence: 0, turnId: "turn-flat-tree" },
      meta: { at: "2026-01-01T00:00:00.100Z" },
      type: "turn.completed",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const root = spans.find(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    const steps = spans.filter((span) =>
      String(span.span_attributes?.name).startsWith("eve.step"),
    );
    const tool = spans.find((span) => span.span_attributes?.name === "search");

    expect(spans.map((span) => span.span_attributes?.name)).toEqual([
      "eve.turn",
      "eve.step",
      "search",
      "eve.step",
    ]);
    expect(root).toMatchObject({
      input: [{ content: "Search then read", role: "user" }],
      metadata: {
        ...expectedModelMetadata,
        "eve.session_id": "session-flat-tree",
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      },
      metrics: {
        completion_tokens: 13,
        estimated_cost: 0.001,
        prompt_cached_tokens: 3,
        prompt_cache_creation_tokens: 2,
        prompt_tokens: 30,
        tokens: 43,
      },
      output: "Here is the Eve instrumentation guide.",
      span_attributes: {
        name: "eve.turn",
        type: "task",
      },
      root_span_id: deterministicEveIdForTest(
        "eve:root",
        "session-flat-tree",
        "turn-flat-tree",
      ),
      span_parents: [],
    });
    expect(steps).toHaveLength(2);
    expect(steps.map((span) => span.span_attributes?.name)).toEqual([
      "eve.step",
      "eve.step",
    ]);
    expect(steps.map((span) => span.span_attributes?.type)).toEqual([
      "llm",
      "llm",
    ]);
    expect(steps.map((span) => span.span_parents)).toEqual([
      [root?.span_id],
      [root?.span_id],
    ]);
    for (const step of steps) {
      expect(step.metadata).toEqual({
        ...expectedModelMetadata,
        "eve.session_id": "session-flat-tree",
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      });
    }
    expect(steps[0]?.input).toBeUndefined();
    expect(steps[1]?.input).toBeUndefined();
    expect(tool).toMatchObject({
      input: { query: "Eve instrumentation" },
      metadata: {
        "eve.session_id": "session-flat-tree",
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      },
      output: { hits: ["eve.dev/docs"] },
      span_attributes: {
        name: "search",
        type: "tool",
      },
      span_parents: [root?.span_id],
    });
    expect(tool?.metadata).not.toHaveProperty("model");
    expect(tool?.metadata).not.toHaveProperty("provider");
    expect(steps[0]?.output).toMatchObject([
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({ query: "Eve instrumentation" }),
                name: "search",
              },
              id: "call-search",
              type: "function",
            },
          ],
        },
      },
    ]);
    expect(steps[1]?.output).toMatchObject([
      {
        finish_reason: "stop",
        message: {
          content: "Here is the Eve instrumentation guide.",
          role: "assistant",
        },
      },
    ]);
  });

  it("records each user message as a separate turn in one session", async () => {
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = { session: { id: "session-multi-turn" } };
    for (const [sequence, message] of [
      [0, "First user message"],
      [1, "Second user message"],
    ] as const) {
      const turnId = `turn-${sequence}`;
      await wildcard?.(
        { data: { sequence, turnId }, type: "turn.started" },
        ctx,
      );
      await wildcard?.(
        { data: { message, sequence, turnId }, type: "message.received" },
        ctx,
      );
      await wildcard?.(
        { data: { sequence, turnId }, type: "turn.completed" },
        ctx,
      );
    }

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const turns = spans.filter(
      (span) => span.span_attributes?.name === "eve.turn",
    );

    expect(
      spans.some((span) => span.span_attributes?.name === "eve.session"),
    ).toBe(false);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.span_parents)).toEqual([[], []]);
    expect(turns.map((turn) => turn.root_span_id)).toEqual([
      deterministicEveIdForTest("eve:root", "session-multi-turn", "turn-0"),
      deterministicEveIdForTest("eve:root", "session-multi-turn", "turn-1"),
    ]);
    expect(turns[0]?.root_span_id).not.toBe(turns[1]?.root_span_id);
    expect(turns.map((turn) => turn.input)).toEqual([
      [{ content: "First user message", role: "user" }],
      [{ content: "Second user message", role: "user" }],
    ]);
  });

  it("merges incremental tool-call batches without reconstructing later LLM inputs", async () => {
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      session: { id: "session-incremental-tools" },
    };
    const emit = (event: EveHandleMessageStreamEvent) => wildcard?.(event, ctx);

    await emit({
      data: { sequence: 0, turnId: "turn-incremental-tools" },
      type: "turn.started",
    });
    await emit({
      data: {
        message: "Search then read",
        sequence: 0,
        turnId: "turn-incremental-tools",
      },
      type: "message.received",
    });
    await emit({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-incremental-tools" },
      type: "step.started",
    });
    await emit({
      data: {
        actions: [
          {
            callId: "call-search",
            input: { query: "Eve instrumentation" },
            kind: "tool-call",
            toolName: "search",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-incremental-tools",
      },
      type: "actions.requested",
    });
    await emit({
      data: {
        actions: [
          {
            callId: "call-search",
            input: { query: "Updated Eve instrumentation" },
            kind: "tool-call",
            toolName: "search",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-incremental-tools",
      },
      type: "actions.requested",
    });
    await emit({
      data: {
        actions: [
          {
            callId: "call-read",
            input: { url: "https://eve.dev/docs/guides/instrumentation" },
            kind: "tool-call",
            toolName: "read",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-incremental-tools",
      },
      type: "actions.requested",
    });
    await emit({
      data: {
        result: {
          callId: "call-search",
          kind: "tool-result",
          output: { url: "https://eve.dev/docs/guides/instrumentation" },
          toolName: "search",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-incremental-tools",
      },
      type: "action.result",
    });
    await emit({
      data: {
        result: {
          callId: "call-read",
          kind: "tool-result",
          output: { excerpt: "Eve hooks expose runtime stream events." },
          toolName: "read",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-incremental-tools",
      },
      type: "action.result",
    });
    await emit({
      data: {
        finishReason: "tool-calls",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-incremental-tools",
      },
      type: "step.completed",
    });
    await emit({
      data: { sequence: 0, stepIndex: 1, turnId: "turn-incremental-tools" },
      type: "step.started",
    });
    await emit({
      data: {
        finishReason: "stop",
        message: "Done.",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-incremental-tools",
      },
      type: "message.completed",
    });
    await emit({
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-incremental-tools",
      },
      type: "step.completed",
    });
    await emit({
      data: { sequence: 0, turnId: "turn-incremental-tools" },
      type: "turn.completed",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const steps = spans.filter((span) =>
      String(span.span_attributes?.name).startsWith("eve.step"),
    );

    expect(steps[0]?.output).toMatchObject([
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({
                  query: "Updated Eve instrumentation",
                }),
                name: "search",
              },
              id: "call-search",
              type: "function",
            },
            {
              function: {
                arguments: JSON.stringify({
                  url: "https://eve.dev/docs/guides/instrumentation",
                }),
                name: "read",
              },
              id: "call-read",
              type: "function",
            },
          ],
        },
      },
    ]);
    expect(steps[1]?.input).toBeUndefined();
  });

  it("merges late tool results into tool spans closed by turn completion", async () => {
    const eveState = createFakeDefineState();
    const wildcard = braintrustEveHook({
      defineState: eveState.defineState,
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-late-tool-result",
      },
    }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      session: { id: "session-late-tool-result" },
    };
    const emit = (event: EveHandleMessageStreamEvent) => wildcard?.(event, ctx);

    await emit({
      data: { sequence: 0, turnId: "turn-late-tool-result" },
      meta: { at: "2026-01-01T00:00:00.000Z" },
      type: "turn.started",
    });
    await emit({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-late-tool-result" },
      meta: { at: "2026-01-01T00:00:00.010Z" },
      type: "step.started",
    });
    await emit({
      data: {
        actions: [
          {
            callId: "call-late-search",
            input: { query: "late tool result" },
            kind: "tool-call",
            toolName: "search",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-late-tool-result",
      },
      meta: { at: "2026-01-01T00:00:00.020Z" },
      type: "actions.requested",
    });
    await emit({
      data: { sequence: 0, turnId: "turn-late-tool-result" },
      meta: { at: "2026-01-01T00:00:00.030Z" },
      type: "turn.completed",
    });
    expect(eveState.values.get("braintrust.eve.tracing")).toMatchObject({
      spanReferences: expect.arrayContaining([
        expect.objectContaining({
          exported: expect.any(String),
          rootSpanId: deterministicEveIdForTest(
            "eve:root",
            "session-late-tool-result",
            "turn-late-tool-result",
          ),
          rowId: deterministicEveIdForTest(
            "eve:row:tool",
            "session-late-tool-result",
            "turn-late-tool-result",
            "call-late-search",
          ),
          spanId: deterministicEveIdForTest(
            "eve:tool",
            "session-late-tool-result",
            "turn-late-tool-result",
            "call-late-search",
          ),
        }),
      ]),
      stepStarts: [],
    });
    const initialWrites = (await backgroundLogger.drain()) as Array<
      Record<string, any> & { id: string }
    >;
    const resumedWildcard = braintrustEveHook({
      defineState: eveState.defineState,
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-late-tool-result",
      },
    }).events?.["*"];
    const flushSpy = vi.spyOn(backgroundLogger, "flush");
    flushSpy.mockClear();
    await resumedWildcard?.(
      {
        data: {
          result: {
            callId: "call-late-search",
            kind: "tool-result",
            output: { title: "Late result" },
            toolName: "search",
          },
          sequence: 0,
          status: "completed",
          stepIndex: 0,
          turnId: "turn-late-tool-result",
        },
        meta: { at: "2026-01-01T00:00:00.040Z" },
        type: "action.result",
      },
      ctx,
    );
    expect(flushSpy).not.toHaveBeenCalled();

    const resumedWrites = (await backgroundLogger.drain()) as Array<
      Record<string, any> & { id: string }
    >;
    expect(
      [...initialWrites, ...resumedWrites].every(
        (span) => span._is_merge === true,
      ),
    ).toBe(true);

    // The backend may ingest separate workflow uploads out of order. Because
    // every write is a merge, a delayed initial write cannot erase the result.
    const spans = mergeRowBatch([...resumedWrites, ...initialWrites]);
    const turns = spans.filter(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    const tool = spans.find((span) => span.span_attributes?.name === "search");

    expect(turns).toHaveLength(1);
    expect(
      spans.filter((span) => span.span_attributes?.name === "search"),
    ).toHaveLength(1);
    expect(tool).toMatchObject({
      input: { query: "late tool result" },
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-late-tool-result",
      },
      output: { title: "Late result" },
      span_attributes: {
        name: "search",
        type: "tool",
      },
      span_parents: [turns[0]?.span_id],
    });
    expect(tool?.metrics?.end).toEqual(expect.any(Number));
  });

  it("lets action results complete sparse subagent events across workflow steps", async () => {
    const eveState = createFakeDefineState();
    const ctx: EveHookContext = {
      session: { id: "session-sparse-subagent" },
    };
    const firstWildcard = braintrustEveHook({
      defineState: eveState.defineState,
    }).events?.["*"];

    await firstWildcard?.(
      {
        data: { sequence: 0, turnId: "turn-sparse-subagent" },
        type: "turn.started",
      },
      ctx,
    );
    await firstWildcard?.(
      {
        data: {
          actions: [
            {
              callId: "call-sparse-subagent",
              input: { message: "Research Eve" },
              kind: "subagent-call",
              subagentName: "researcher",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-sparse-subagent",
        },
        type: "actions.requested",
      },
      ctx,
    );
    await firstWildcard?.(
      {
        data: {
          callId: "call-sparse-subagent",
          sequence: 0,
          subagentName: "researcher",
          turnId: "turn-sparse-subagent",
        },
        meta: { at: "2026-01-01T00:00:00.100Z" },
        type: "subagent.completed",
      },
      ctx,
    );

    const resumedWildcard = braintrustEveHook({
      defineState: eveState.defineState,
    }).events?.["*"];
    await resumedWildcard?.(
      {
        data: {
          result: {
            callId: "call-sparse-subagent",
            kind: "subagent-result",
            output: { answer: "Authoritative result" },
            subagentName: "researcher",
          },
          sequence: 0,
          status: "completed",
          stepIndex: 0,
          turnId: "turn-sparse-subagent",
        },
        meta: { at: "2026-01-01T00:00:00.500Z" },
        type: "action.result",
      },
      ctx,
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const subagents = spans.filter(
      (span) => span.span_attributes?.name === "researcher",
    );
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      output: { answer: "Authoritative result" },
      metrics: { end: Date.parse("2026-01-01T00:00:00.100Z") / 1000 },
      span_attributes: { type: "tool" },
    });
  });

  it("evicts tracing state after session completion", async () => {
    const fakeEve = createFakeDefineState();
    defineState = fakeEve.defineState;
    const wildcard = braintrustEveHook({
      defineState,
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-late-after-session",
      },
    }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      session: { id: "session-late-after-session" },
    };
    const emit = (event: EveHandleMessageStreamEvent) => wildcard?.(event, ctx);

    await emit({
      data: { sequence: 0, turnId: "turn-late-after-session" },
      meta: { at: "2026-01-01T00:00:00.000Z" },
      type: "turn.started",
    });
    await emit({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-late-after-session" },
      meta: { at: "2026-01-01T00:00:00.010Z" },
      type: "step.started",
    });
    await emit({
      data: {
        actions: [
          {
            callId: "call-after-session",
            input: { query: "after session" },
            kind: "tool-call",
            toolName: "search",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-late-after-session",
      },
      meta: { at: "2026-01-01T00:00:00.020Z" },
      type: "actions.requested",
    });
    await emit({
      meta: { at: "2026-01-01T00:00:00.030Z" },
      type: "session.completed",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const tool = spans.find((span) => span.span_attributes?.name === "search");
    expect(tool).toMatchObject({
      input: { query: "after session" },
    });
    expect(tool?.metrics?.end).toEqual(expect.any(Number));
    expect(fakeEve.values.get("braintrust.eve.tracing")).toEqual({
      llmInputs: [],
      metadata: {},
      spanReferences: [],
      stepStarts: [],
    });
  });

  it("records result-only tool events without invented input", async () => {
    const wildcard = braintrustEveHook({
      defineState,
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-result-only",
      },
    }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      session: { id: "session-result-only" },
    };
    const emit = (event: EveHandleMessageStreamEvent) => wildcard?.(event, ctx);

    await emit({
      data: {
        result: {
          callId: "call-result-only",
          kind: "tool-result",
          output: { title: "Result only" },
          toolName: "search",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-result-only",
      },
      type: "action.result",
    });
    await emit({
      data: { sequence: 0, turnId: "turn-result-only" },
      type: "turn.completed",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const tool = spans.find((span) => span.span_attributes?.name === "search");
    expect(tool).toMatchObject({
      output: { title: "Result only" },
      span_attributes: { name: "search", type: "tool" },
    });
    expect(tool?.input).toBeUndefined();
  });

  it("evicts tracing state after session failure", async () => {
    const fakeEve = createFakeDefineState();
    const wildcard = braintrustEveHook({
      defineState: fakeEve.defineState,
    }).events?.["*"];
    const ctx: EveHookContext = {
      session: { id: "session-failed-cleanup" },
    };

    await wildcard?.(
      {
        data: { sequence: 0, turnId: "turn-failed-cleanup" },
        type: "turn.started",
      },
      ctx,
    );
    await wildcard?.(
      {
        data: {
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-failed-cleanup",
        },
        type: "step.started",
      },
      ctx,
    );
    await wildcard?.(
      {
        data: {
          code: "session_failed",
          message: "Session failed",
          sessionId: "session-failed-cleanup",
        },
        type: "session.failed",
      },
      ctx,
    );

    expect(fakeEve.values.get("braintrust.eve.tracing")).toEqual({
      llmInputs: [],
      metadata: {},
      spanReferences: [],
      stepStarts: [],
    });
  });

  it("flushes final session events but not ordinary or ignored events", async () => {
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    const ctx: EveHookContext = {
      session: { id: "session-selective-flush" },
    };

    await wildcard?.(
      {
        data: { sequence: 0, turnId: "turn-selective-flush" },
        type: "turn.started",
      },
      ctx,
    );
    const flushSpy = vi
      .spyOn(backgroundLogger, "flush")
      .mockResolvedValue(undefined);

    await wildcard?.(
      {
        data: { wait: "next-user-message" },
        type: "session.waiting",
      },
      ctx,
    );
    expect(flushSpy).not.toHaveBeenCalled();

    await wildcard?.(
      {
        data: {
          finishReason: "stop",
          message: null,
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-selective-flush",
        },
        type: "message.completed",
      },
      ctx,
    );
    expect(flushSpy).not.toHaveBeenCalled();

    await wildcard?.(
      {
        type: "session.completed",
      },
      ctx,
    );
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it("serializes events per session without blocking other sessions", async () => {
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    expect(wildcard).toBeDefined();

    const sessionA: EveHookContext = { session: { id: "session-queue-a" } };
    const sessionB: EveHookContext = { session: { id: "session-queue-b" } };
    const emitA = (event: EveHandleMessageStreamEvent) =>
      wildcard?.(event, sessionA);
    const emitB = (event: EveHandleMessageStreamEvent) =>
      wildcard?.(event, sessionB);

    await emitA({
      data: { sequence: 0, turnId: "turn-a" },
      type: "turn.started",
    });
    await emitB({
      data: { sequence: 0, turnId: "turn-b" },
      type: "turn.started",
    });

    let releaseFirstFlush: (() => void) | undefined;
    const firstFlush = new Promise<void>((resolve) => {
      releaseFirstFlush = resolve;
    });
    const flushSpy = vi
      .spyOn(backgroundLogger, "flush")
      .mockImplementationOnce(() => firstFlush)
      .mockResolvedValue(undefined);

    const doneA = emitA({
      type: "session.completed",
    });
    for (let i = 0; i < 10 && flushSpy.mock.calls.length < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(flushSpy).toHaveBeenCalledTimes(1);

    let queuedEventFinished = false;
    const queuedA = Promise.resolve(
      emitA({
        data: {
          finishReason: "stop",
          message: "queued",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-a",
        },
        type: "message.completed",
      }),
    ).then(() => {
      queuedEventFinished = true;
    });
    await Promise.resolve();
    expect(queuedEventFinished).toBe(false);

    await emitB({
      data: { sequence: 0, turnId: "turn-b" },
      type: "turn.completed",
    });
    expect(queuedEventFinished).toBe(false);

    releaseFirstFlush?.();
    await Promise.all([doneA, queuedA]);
    expect(queuedEventFinished).toBe(true);
  });

  it("uses deterministic ids and attaches local subagent turns to their tool span", async () => {
    const parentEveState = createFakeDefineState();
    const childEveState = createFakeDefineState();
    const parentWildcard = braintrustEveHook({
      defineState: parentEveState.defineState,
    }).events?.["*"];
    const childWildcard = braintrustEveHook({
      defineState: childEveState.defineState,
    }).events?.["*"];
    expect(parentWildcard).toBeDefined();
    expect(childWildcard).toBeDefined();

    const parentCtx: EveHookContext = {
      session: { id: "session-parent" },
    };
    const childCtx: EveHookContext = {
      session: {
        id: "session-child",
        parent: {
          callId: "call-researcher",
          sessionId: "session-parent",
          turn: { id: "turn-parent" },
        },
      },
    };
    const emitParent = (event: EveHandleMessageStreamEvent) =>
      parentWildcard?.(event, parentCtx);
    const emitChild = (event: EveHandleMessageStreamEvent) =>
      childWildcard?.(event, childCtx);

    await emitParent({
      data: { sequence: 0, turnId: "turn-parent" },
      type: "turn.started",
    });
    await emitParent({
      data: {
        message: "Research Eve tracing",
        sequence: 0,
        turnId: "turn-parent",
      },
      type: "message.received",
    });
    await emitParent({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-parent" },
      type: "step.started",
    });
    await emitParent({
      data: {
        actions: [
          {
            callId: "call-researcher",
            input: { message: "Find the relevant section" },
            kind: "subagent-call",
            name: "researcher",
            subagentName: "researcher",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-parent",
      },
      type: "actions.requested",
    });
    await emitParent({
      data: {
        callId: "call-researcher",
        childSessionId: "session-child",
        name: "researcher",
        sequence: 0,
        toolName: "researcher",
        turnId: "turn-parent",
      },
      type: "subagent.called",
    });

    await emitChild({
      data: { sequence: 0, turnId: "turn-child" },
      type: "turn.started",
    });
    await emitChild({
      data: {
        message: "Find the relevant section",
        sequence: 0,
        turnId: "turn-child",
      },
      type: "message.received",
    });
    await emitChild({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-child" },
      type: "step.started",
    });
    await emitChild({
      data: {
        actions: [
          {
            callId: "call-search",
            input: { query: "nested eve" },
            kind: "tool-call",
            toolName: "search",
          },
        ],
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-child",
      },
      type: "actions.requested",
    });
    await emitChild({
      data: {
        result: {
          callId: "call-search",
          kind: "tool-result",
          output: { title: "Nested Eve" },
          toolName: "search",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 1,
        turnId: "turn-child",
      },
      type: "action.result",
    });
    await emitChild({
      data: {
        finishReason: "stop",
        message: "Child found Nested Eve.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-child",
      },
      type: "message.completed",
    });
    await emitChild({
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-child",
      },
      type: "step.completed",
    });
    await emitChild({
      data: { sequence: 0, turnId: "turn-child" },
      type: "turn.completed",
    });

    await emitParent({
      data: {
        callId: "call-researcher",
        output: "Child found Nested Eve.",
        sequence: 0,
        status: "completed",
        subagentName: "researcher",
        turnId: "turn-parent",
      },
      type: "subagent.completed",
    });
    await emitParent({
      data: {
        result: {
          callId: "call-researcher",
          kind: "subagent-result",
          output: "Child found Nested Eve.",
          subagentName: "researcher",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-parent",
      },
      type: "action.result",
    });
    await emitParent({
      data: { sequence: 0, stepIndex: 1, turnId: "turn-parent" },
      type: "step.started",
    });
    await emitParent({
      data: {
        actions: [
          {
            callId: "call-read",
            input: { url: "https://eve.dev/docs/guides/instrumentation" },
            kind: "tool-call",
            toolName: "read",
          },
        ],
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-parent",
      },
      type: "actions.requested",
    });
    await emitParent({
      data: {
        result: {
          callId: "call-read",
          kind: "tool-result",
          output: { title: "Runtime context" },
          toolName: "read",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 1,
        turnId: "turn-parent",
      },
      type: "action.result",
    });
    await emitParent({
      data: {
        finishReason: "tool-calls",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-parent",
      },
      type: "step.completed",
    });
    await emitParent({
      data: { sequence: 0, stepIndex: 2, turnId: "turn-parent" },
      type: "step.started",
    });
    await emitParent({
      data: {
        finishReason: "stop",
        message: "Parent used the child result.",
        sequence: 0,
        stepIndex: 2,
        turnId: "turn-parent",
      },
      type: "message.completed",
    });
    await emitParent({
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 2,
        turnId: "turn-parent",
      },
      type: "step.completed",
    });
    await emitParent({
      data: { sequence: 0, turnId: "turn-parent" },
      type: "turn.completed",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const parentTurnId = deterministicEveIdForTest(
      "eve:turn",
      "session-parent",
      "turn-parent",
    );
    const childTurnId = deterministicEveIdForTest(
      "eve:turn",
      "session-child",
      "turn-child",
    );
    const subagentSpanId = deterministicEveIdForTest(
      "eve:subagent",
      "session-parent",
      "call-researcher",
    );
    const parentTurn = spans.find(
      (span) =>
        span.span_attributes?.name === "eve.turn" &&
        span.span_id === parentTurnId,
    );
    const subagentSpans = spans.filter(
      (span) => span.span_attributes?.name === "researcher",
    );
    const childTurn = spans.find(
      (span) =>
        span.span_attributes?.name === "eve.turn" &&
        span.span_id === childTurnId,
    );
    const childSearch = spans.find(
      (span) =>
        span.span_attributes?.name === "search" &&
        span.span_parents?.[0] === childTurnId,
    );
    const parentRead = spans.find(
      (span) =>
        span.span_attributes?.name === "read" &&
        span.span_parents?.[0] === parentTurnId,
    );
    const parentSteps = spans.filter(
      (span) =>
        span.span_attributes?.name === "eve.step" &&
        span.span_parents?.[0] === parentTurnId,
    );

    expect(parentTurn).toBeDefined();
    expect(subagentSpans).toHaveLength(1);
    expect(subagentSpans[0]?.span_id).toBe(subagentSpanId);
    expect(subagentSpans[0]?.input).toEqual({
      message: "Find the relevant section",
    });
    expect(childTurn).toBeDefined();
    expect(childSearch).toBeDefined();
    expect(parentRead).toBeDefined();
    expect(parentSteps).toHaveLength(3);
    expect(parentTurn?.span_parents).toEqual([]);
    expect(parentTurn?.span_id).toBe(parentTurnId);
    expect(parentTurn?.span_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(parentTurn?.root_span_id).toMatch(
      /^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    );
    expect(parentTurn?.root_span_id).toBe(
      deterministicEveIdForTest("eve:root", "session-parent", "turn-parent"),
    );
    expect(subagentSpans[0]?.span_parents).toEqual([parentTurn?.span_id]);
    expect(childTurn?.span_parents).toEqual([subagentSpanId]);
    expect(childTurn?.root_span_id).toBe(parentTurn?.root_span_id);
    expect(parentTurn?.metadata).toEqual({
      "eve.session_id": "session-parent",
    });
    expect(subagentSpans[0]?.metadata).toEqual({
      "eve.session_id": "session-parent",
    });
    expect(childTurn?.metadata).toEqual({
      "eve.session_id": "session-child",
    });
    expect(childSearch?.metadata).toEqual({
      "eve.session_id": "session-child",
    });
    expect(parentRead?.metadata).toEqual({
      "eve.session_id": "session-parent",
    });
    expect(childSearch?.span_parents).toEqual([childTurn?.span_id]);
    expect(childSearch?.span_id).toBe(
      deterministicEveIdForTest(
        "eve:tool",
        "session-child",
        "turn-child",
        "call-search",
      ),
    );
    expect(parentRead?.span_id).toBe(
      deterministicEveIdForTest(
        "eve:tool",
        "session-parent",
        "turn-parent",
        "call-read",
      ),
    );
    expect(parentSteps.map((span) => span.span_id)).toEqual([
      deterministicEveIdForTest(
        "eve:step",
        "session-parent",
        "turn-parent",
        "0",
      ),
      deterministicEveIdForTest(
        "eve:step",
        "session-parent",
        "turn-parent",
        "1",
      ),
      deterministicEveIdForTest(
        "eve:step",
        "session-parent",
        "turn-parent",
        "2",
      ),
    ]);
    expect(spans.map((span) => span.span_attributes?.name)).toEqual([
      "eve.turn",
      "eve.step",
      "researcher",
      "eve.turn",
      "eve.step",
      "search",
      "eve.step",
      "read",
      "eve.step",
    ]);

    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "eve-plugin.test.ts",
      projectId: "test-project-id",
    });
    const replay = braintrustEveHook({
      defineState: parentEveState.defineState,
    }).events?.["*"];
    await replay?.(
      {
        data: { sequence: 0, turnId: "turn-parent" },
        type: "turn.started",
      },
      parentCtx,
    );
    await replay?.(
      {
        data: { sequence: 0, turnId: "turn-parent" },
        type: "turn.completed",
      },
      parentCtx,
    );
    const replaySpans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(
      replaySpans.find((span) => span.span_id === parentTurn?.span_id),
    ).toMatchObject({ _is_merge: true });
  });

  it("does not parent an Eve turn under the active Braintrust span", async () => {
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      session: { id: "session-wrapped" },
    };
    const parent = startSpan({ name: "workflow" });
    await withCurrent(parent, async () => {
      await wildcard?.(
        {
          data: { sequence: 0, turnId: "turn-wrapped" },
          type: "turn.started",
        },
        ctx,
      );
      await wildcard?.(
        {
          data: { sequence: 0, turnId: "turn-wrapped" },
          type: "turn.completed",
        },
        ctx,
      );
    });
    parent.end();

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const turn = spans.find(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    expect(turn?.span_id).toBe(
      deterministicEveIdForTest("eve:turn", "session-wrapped", "turn-wrapped"),
    );
    expect(turn?.span_parents).toEqual([]);
    expect(turn?.root_span_id).toBe(
      deterministicEveIdForTest("eve:root", "session-wrapped", "turn-wrapped"),
    );
    expect(turn?.root_span_id).not.toBe(parent.rootSpanId);
  });

  it("does not throw when Eve emits malformed events or failures", async () => {
    const wildcard = braintrustEveHook({ defineState }).events?.["*"];
    expect(wildcard).toBeDefined();

    await expect(
      wildcard?.({ bad: true } as never, {}),
    ).resolves.toBeUndefined();
    await expect(
      wildcard?.(
        {
          data: {
            code: "boom",
            message: "step failed",
            sequence: 0,
            stepIndex: 0,
            turnId: "turn-missing-session",
          },
          type: "step.failed",
        },
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      wildcard?.(
        {
          data: { runtime: { modelId: 123 } },
          type: "session.started",
        } as never,
        { session: { id: "session-malformed-runtime" } },
      ),
    ).resolves.toBeUndefined();

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(spans).toEqual([]);
  });
});
