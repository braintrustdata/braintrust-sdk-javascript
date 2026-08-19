import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as braintrustExports from "../../exports";
import { configureNode } from "../../node/config";
import { Attachment, _exportsForTestingOnly, initLogger } from "../../logger";
import * as instrumentationExports from "../index";
import { braintrustEveInstrumentation } from "./eve-plugin";
import type {
  EveInstrumentationAttemptScope,
  EveInstrumentationHandlerContext,
  EveInstrumentationModelCallCompletedEvent,
  EveJsonValue,
} from "../../vendor-sdk-types/eve";

const ATTEMPT_SCOPE: EveInstrumentationAttemptScope = {
  attemptId: "attempt-0",
  attemptIndex: 0,
  rootSessionId: "session-root",
  sessionId: "session-root",
  stepIndex: 0,
  turnId: "turn-0",
};

function providerContext(
  initial?: EveJsonValue,
): EveInstrumentationHandlerContext {
  let value = initial;
  return {
    state: {
      get: () => value,
      set: (next) => {
        value = next;
      },
    },
  };
}

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("braintrustEveInstrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
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

  it("returns an Eve 0.34+ instrumentation provider", () => {
    const setup = vi.fn();
    const provider = braintrustEveInstrumentation({ setup });

    expect(provider.capture).toBe("content");
    expect(provider.setup).toBe(setup);
    expect(typeof provider.flush).toBe("function");
    expect(Object.keys(provider.events).sort()).toEqual([
      "action.completed",
      "action.failed",
      "action.started",
      "model.call.completed",
      "model.call.failed",
      "model.call.started",
      "step.attempt.completed",
      "step.attempt.failed",
      "turn.cancelled",
      "turn.completed",
      "turn.failed",
      "turn.started",
    ]);
  });

  it("exports only the Eve instrumentation provider API", () => {
    expect(braintrustExports.braintrustEveInstrumentation).toBe(
      braintrustEveInstrumentation,
    );
    expect(instrumentationExports.braintrustEveInstrumentation).toBe(
      braintrustEveInstrumentation,
    );
    expect(braintrustExports).not.toHaveProperty("braintrustEveHook");
    expect(instrumentationExports).not.toHaveProperty("braintrustEveHook");
  });

  it("records a turn with LLM and action spans", async () => {
    const provider = braintrustEveInstrumentation({
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      },
    });
    const turnContext = providerContext();
    const firstModelContext = providerContext();
    const actionContext = providerContext();
    const secondModelContext = providerContext();
    const scope = ATTEMPT_SCOPE;

    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      turnContext,
    );
    await provider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-0:0",
        input: {
          instructions: "You are a research agent.",
          messages: [{ content: "Search then read", role: "user" }],
        },
        model: {
          modelId: "qwen/qwen3-30b-a3b",
          provider: "openrouter.chat",
        },
        scope,
        type: "model.call.started",
      },
      firstModelContext,
    );
    await provider.events["model.call.completed"](
      {
        content: [
          { text: "I should search first.", type: "reasoning" },
          {
            callId: "call-search",
            input: { query: "Eve instrumentation" },
            toolName: "search",
            type: "tool-call",
          },
        ],
        finishReason: "tool-calls",
        idempotencyKey: "model:attempt-0:0",
        scope,
        type: "model.call.completed",
        usage: {
          inputTokenDetails: {
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
          },
          inputTokens: 10,
          outputTokens: 5,
        },
      },
      firstModelContext,
    );
    await provider.events["action.started"](
      {
        callId: "call-search",
        idempotencyKey: "action:session-root:turn-0:call-search",
        input: { query: "Eve instrumentation" },
        name: "search",
        scope,
        type: "action.started",
      },
      actionContext,
    );
    await provider.events["action.completed"](
      {
        idempotencyKey: "action:session-root:turn-0:call-search",
        output: {
          output: { hits: ["eve.dev/docs"] },
          type: "result",
        },
        scope,
        type: "action.completed",
      },
      actionContext,
    );
    await provider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-1:0",
        input: {
          instructions: "You are a research agent.",
          messages: [
            { content: "Search then read", role: "user" },
            {
              content: [
                {
                  input: { query: "Eve instrumentation" },
                  toolCallId: "call-search",
                  toolName: "search",
                  type: "tool-call",
                },
              ],
              role: "assistant",
            },
          ],
        },
        model: {
          modelId: "qwen/qwen3-30b-a3b",
          provider: "openrouter.chat",
        },
        scope,
        type: "model.call.started",
      },
      secondModelContext,
    );
    await provider.events["model.call.completed"](
      {
        content: [
          {
            text: "Here is the Eve instrumentation guide.",
            type: "text",
          },
        ],
        finishReason: "stop",
        idempotencyKey: "model:attempt-1:0",
        scope,
        type: "model.call.completed",
        usage: {
          inputTokens: 20,
          outputTokens: 8,
        },
      },
      secondModelContext,
    );
    await provider.events["turn.completed"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.completed",
      },
      turnContext,
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const root = spans.find(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    const steps = spans.filter(
      (span) => span.span_attributes?.name === "eve.step",
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
        "eve.session_id": "session-root",
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      },
      output: "Here is the Eve instrumentation guide.",
      metrics: {
        completion_tokens: 13,
        prompt_cache_creation_tokens: 2,
        prompt_cached_tokens: 3,
        prompt_tokens: 30,
        tokens: 43,
      },
      span_attributes: {
        name: "eve.turn",
        type: "task",
      },
      span_parents: [],
    });
    expect(root?.root_span_id).not.toBe(root?.span_id);
    expect(root?.metadata).not.toHaveProperty("model");
    expect(root?.metadata).not.toHaveProperty("provider");

    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step).toMatchObject({
        metadata: {
          "eve.session_id": "session-root",
          model: "qwen/qwen3-30b-a3b",
          provider: "openrouter",
          scenario: "eve-plugin-unit",
          testRunId: "test-run-flat-tree",
        },
        span_attributes: {
          name: "eve.step",
          type: "llm",
        },
        span_parents: [root?.span_id],
      });
    }
    expect(steps[0]?.metadata).not.toHaveProperty("tools");
    expect(steps[0]?.output).toMatchObject([
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          reasoning: [{ content: "I should search first." }],
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({
                  query: "Eve instrumentation",
                }),
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
    expect(tool).toMatchObject({
      input: { query: "Eve instrumentation" },
      metadata: {
        "eve.session_id": "session-root",
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
  });

  it("attaches a subagent turn beneath its action span", async () => {
    const provider = braintrustEveInstrumentation();
    const parentTurnContext = providerContext();
    const actionContext = providerContext();
    const childTurnContext = providerContext();
    const childModelContext = providerContext();
    const parentScope = ATTEMPT_SCOPE;

    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      parentTurnContext,
    );
    await provider.events["action.started"](
      {
        callId: "call-researcher",
        idempotencyKey: "action:session-root:turn-0:call-researcher",
        input: { message: "Research Eve" },
        name: "researcher",
        scope: parentScope,
        type: "action.started",
      },
      actionContext,
    );
    await Promise.all([
      provider.events["turn.started"](
        {
          idempotencyKey: "turn:session-child:turn-0",
          parentLineage: {
            callId: "call-researcher",
            sessionId: "session-root",
            turnId: "turn-0",
          },
          rootSessionId: "session-root",
          sequence: 0,
          sessionId: "session-child",
          turnId: "turn-0",
          type: "turn.started",
        },
        childTurnContext,
      ),
      provider.events["model.call.started"](
        {
          idempotencyKey: "model:child-attempt-0:0",
          model: {
            modelId: "qwen/qwen3-30b-a3b",
            provider: "openrouter.chat",
          },
          scope: {
            attemptId: "child-attempt-0",
            attemptIndex: 0,
            rootSessionId: "session-root",
            sessionId: "session-child",
            stepIndex: 0,
            turnId: "turn-0",
          },
          type: "model.call.started",
        },
        childModelContext,
      ),
    ]);

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const parent = spans.find(
      (span) =>
        span.span_attributes?.name === "eve.turn" &&
        span.metadata?.["eve.session_id"] === "session-root",
    );
    const action = spans.find(
      (span) => span.span_attributes?.name === "researcher",
    );
    const child = spans.find(
      (span) =>
        span.span_attributes?.name === "eve.turn" &&
        span.metadata?.["eve.session_id"] === "session-child",
    );
    const childModel = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );

    expect(action?.span_parents).toEqual([parent?.span_id]);
    expect(child?.span_parents).toEqual([action?.span_id]);
    expect(child?.root_span_id).toBe(parent?.root_span_id);
    expect(childModel?.span_parents).toEqual([child?.span_id]);
    expect(childModel?.root_span_id).toBe(parent?.root_span_id);
  });

  it("keeps a stable root across nested subagents with different turn ids", async () => {
    const provider = braintrustEveInstrumentation();
    const rootContext = providerContext();
    const rootScope = { ...ATTEMPT_SCOPE, turnId: "root-turn" };
    const childScope: EveInstrumentationAttemptScope = {
      attemptId: "child-attempt",
      attemptIndex: 0,
      rootSessionId: "session-root",
      sessionId: "session-child",
      stepIndex: 0,
      turnId: "child-turn",
    };

    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:root-turn",
        rootSessionId: "session-root",
        sequence: 4,
        sessionId: "session-root",
        turnId: "root-turn",
        type: "turn.started",
      },
      rootContext,
    );
    await provider.events["action.started"](
      {
        callId: "call-child",
        idempotencyKey: "action:session-root:root-turn:call-child",
        name: "child",
        scope: rootScope,
        type: "action.started",
      },
      providerContext(),
    );
    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-child:child-turn",
        parentLineage: {
          callId: "call-child",
          sessionId: "session-root",
          turnId: "root-turn",
        },
        rootSessionId: "session-root",
        sequence: 2,
        sessionId: "session-child",
        turnId: "child-turn",
        type: "turn.started",
      },
      providerContext(),
    );
    await provider.events["action.started"](
      {
        callId: "call-grandchild",
        idempotencyKey: "action:session-child:child-turn:call-grandchild",
        name: "grandchild",
        scope: childScope,
        type: "action.started",
      },
      providerContext(),
    );
    const rootReference = rootContext.state.get();
    if (
      typeof rootReference !== "object" ||
      rootReference === null ||
      Array.isArray(rootReference) ||
      typeof rootReference.rootSpanId !== "string"
    ) {
      throw new Error("Expected the root turn trace context to be persisted");
    }
    const resumedProvider = braintrustEveInstrumentation();
    await resumedProvider.events["turn.started"](
      {
        idempotencyKey: "turn:session-grandchild:grandchild-turn",
        parentLineage: {
          callId: "call-grandchild",
          sessionId: "session-child",
          turnId: "child-turn",
        },
        parentTraceContext: {
          spanId: "1111111111111111",
          traceFlags: 1,
          traceId: rootReference.rootSpanId,
        },
        rootSessionId: "session-root",
        sequence: 7,
        sessionId: "session-grandchild",
        turnId: "grandchild-turn",
        type: "turn.started",
      },
      providerContext(),
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const turns = spans.filter(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    const root = turns.find(
      (turn) => turn.metadata?.["eve.session_id"] === "session-root",
    );
    const child = turns.find(
      (turn) => turn.metadata?.["eve.session_id"] === "session-child",
    );
    const grandchild = turns.find(
      (turn) => turn.metadata?.["eve.session_id"] === "session-grandchild",
    );
    const childAction = spans.find(
      (span) => span.span_attributes?.name === "child",
    );
    const grandchildAction = spans.find(
      (span) => span.span_attributes?.name === "grandchild",
    );

    expect(child?.span_parents).toEqual([childAction?.span_id]);
    expect(grandchild?.span_parents).toEqual([grandchildAction?.span_id]);
    expect(turns.map((turn) => turn.root_span_id)).toEqual([
      root?.root_span_id,
      root?.root_span_id,
      root?.root_span_id,
    ]);
  });

  it("creates a separate trace for each top-level turn in one session", async () => {
    const provider = braintrustEveInstrumentation();

    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:shared-session:turn-0",
        rootSessionId: "shared-session",
        sequence: 0,
        sessionId: "shared-session",
        turnId: "turn-0",
        type: "turn.started",
      },
      providerContext(),
    );
    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:shared-session:turn-1",
        rootSessionId: "shared-session",
        sequence: 1,
        sessionId: "shared-session",
        turnId: "turn-1",
        type: "turn.started",
      },
      providerContext(),
    );

    const turns = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.metadata?.["eve.session_id"])).toEqual([
      "shared-session",
      "shared-session",
    ]);
    expect(new Set(turns.map((turn) => turn.root_span_id)).size).toBe(2);
  });

  it("preserves a durable subagent turn across provider instances", async () => {
    const firstProvider = braintrustEveInstrumentation();
    const parentTurnContext = providerContext();
    const childTurnContext = providerContext();

    await firstProvider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      parentTurnContext,
    );
    await firstProvider.events["action.started"](
      {
        callId: "call-researcher",
        idempotencyKey: "action:session-root:turn-0:call-researcher",
        name: "researcher",
        scope: ATTEMPT_SCOPE,
        type: "action.started",
      },
      providerContext(),
    );
    await firstProvider.events["turn.started"](
      {
        idempotencyKey: "turn:session-child:turn-0",
        parentLineage: {
          callId: "call-researcher",
          sessionId: "session-root",
          turnId: "turn-0",
        },
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-child",
        turnId: "turn-0",
        type: "turn.started",
      },
      childTurnContext,
    );

    const resumedProvider = braintrustEveInstrumentation();
    const childScope: EveInstrumentationAttemptScope = {
      attemptId: "child-attempt-0",
      attemptIndex: 0,
      rootSessionId: "session-root",
      sessionId: "session-child",
      stepIndex: 0,
      turnId: "turn-0",
    };
    const modelContext = providerContext();
    await resumedProvider.events["model.call.started"](
      {
        idempotencyKey: "model:child-attempt-0:0",
        input: {
          messages: [{ content: "Continue durably", role: "user" }],
        },
        model: { modelId: "gpt-5.4-mini", provider: "openai.responses" },
        scope: childScope,
        type: "model.call.started",
      },
      modelContext,
    );
    await resumedProvider.events["model.call.completed"](
      {
        content: [{ text: "Durable answer", type: "text" }],
        finishReason: "stop",
        idempotencyKey: "model:child-attempt-0:0",
        scope: childScope,
        type: "model.call.completed",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      modelContext,
    );
    await resumedProvider.events["turn.completed"](
      {
        idempotencyKey: "turn:session-child:turn-0",
        sessionId: "session-child",
        turnId: "turn-0",
        type: "turn.completed",
      },
      providerContext(childTurnContext.state.get()),
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const parent = spans.find(
      (span) =>
        span.span_attributes?.name === "eve.turn" &&
        span.metadata?.["eve.session_id"] === "session-root",
    );
    const action = spans.find(
      (span) => span.span_attributes?.name === "researcher",
    );
    const child = spans.find(
      (span) =>
        span.span_attributes?.name === "eve.turn" &&
        span.metadata?.["eve.session_id"] === "session-child",
    );
    const step = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );
    expect(child).toMatchObject({
      input: [{ content: "Continue durably", role: "user" }],
      metrics: {
        completion_tokens: 2,
        prompt_tokens: 3,
        tokens: 5,
      },
      output: "Durable answer",
      span_parents: [action?.span_id],
    });
    expect(child?.root_span_id).toBe(parent?.root_span_id);
    expect(step?.span_parents).toEqual([child?.span_id]);
    expect(step?.root_span_id).toBe(parent?.root_span_id);
  });

  it("resumes spans and turn metrics from Eve operation state", async () => {
    const firstProvider = braintrustEveInstrumentation();
    const turnContext = providerContext();
    const modelContext = providerContext();
    const scope = ATTEMPT_SCOPE;

    await firstProvider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      turnContext,
    );
    await firstProvider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-0:0",
        input: {
          messages: [{ content: "Resume this call", role: "user" }],
        },
        model: {
          modelId: "gpt-5.4-mini",
          provider: "openai.responses",
        },
        scope,
        type: "model.call.started",
      },
      modelContext,
    );

    const persisted = modelContext.state.get();
    expect(persisted).toMatchObject({
      exported: expect.any(String),
      rootSpanId: expect.any(String),
      spanId: expect.any(String),
    });

    const resumedProvider = braintrustEveInstrumentation();
    await resumedProvider.events["model.call.completed"](
      {
        content: [{ text: "Resumed output", type: "text" }],
        finishReason: "stop",
        idempotencyKey: "model:attempt-0:0",
        scope,
        type: "model.call.completed",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
      providerContext(persisted),
    );
    const secondModelContext = providerContext();
    await resumedProvider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-0:1",
        input: {
          messages: [{ content: "Continue this call", role: "user" }],
        },
        model: {
          modelId: "gpt-5.4-mini",
          provider: "openai.responses",
        },
        scope: { ...scope, stepIndex: 1 },
        type: "model.call.started",
      },
      secondModelContext,
    );
    const secondPersisted = secondModelContext.state.get();
    expect(secondPersisted).toMatchObject({
      turnMetricContributions: {
        "model:attempt-0:0": {
          completion_tokens: 2,
          prompt_tokens: 4,
          tokens: 6,
        },
      },
    });
    const finalProvider = braintrustEveInstrumentation();
    await finalProvider.events["model.call.completed"](
      {
        content: [{ text: "Final resumed output", type: "text" }],
        finishReason: "stop",
        idempotencyKey: "model:attempt-0:1",
        scope: { ...scope, stepIndex: 1 },
        type: "model.call.completed",
        usage: { inputTokens: 3, outputTokens: 1 },
      },
      providerContext(secondPersisted),
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const steps = spans.filter(
      (span) => span.span_attributes?.name === "eve.step",
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      input: [{ content: "Resume this call", role: "user" }],
      metrics: {
        completion_tokens: 2,
        prompt_tokens: 4,
        tokens: 6,
      },
      output: [
        {
          finish_reason: "stop",
          message: {
            content: "Resumed output",
            role: "assistant",
          },
        },
      ],
    });
    const turn = spans.find(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    expect(turn?.metrics).toMatchObject({
      completion_tokens: 3,
      prompt_tokens: 7,
      tokens: 10,
    });
  });

  it("does not double-count replayed model completions", async () => {
    const provider = braintrustEveInstrumentation();
    const modelContext = providerContext();
    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:replay-session:turn-0",
        rootSessionId: "replay-session",
        sequence: 0,
        sessionId: "replay-session",
        turnId: "turn-0",
        type: "turn.started",
      },
      providerContext(),
    );
    const scope = {
      ...ATTEMPT_SCOPE,
      attemptId: "replay-attempt",
      rootSessionId: "replay-session",
      sessionId: "replay-session",
    };
    await provider.events["model.call.started"](
      {
        idempotencyKey: "model:replay-attempt:0",
        model: { modelId: "gpt-5.4-mini", provider: "openai.responses" },
        scope,
        type: "model.call.started",
      },
      modelContext,
    );
    const completed: EveInstrumentationModelCallCompletedEvent = {
      content: [{ text: "Done", type: "text" }],
      finishReason: "stop",
      idempotencyKey: "model:replay-attempt:0",
      scope,
      type: "model.call.completed",
      usage: { inputTokens: 3, outputTokens: 2 },
    };
    await provider.events["model.call.completed"](completed, modelContext);
    await provider.events["model.call.completed"](completed, modelContext);

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const turn = spans.find(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    expect(turn?.metrics).toMatchObject({
      completion_tokens: 2,
      prompt_tokens: 3,
      tokens: 5,
    });
  });

  it("records model, action, and turn failures as errors", async () => {
    const provider = braintrustEveInstrumentation();
    const turnContext = providerContext();
    const modelContext = providerContext();
    const actionContext = providerContext();
    const scope = ATTEMPT_SCOPE;

    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      turnContext,
    );
    await provider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-0:0",
        model: { modelId: "gpt-5.4-mini", provider: "openai.responses" },
        scope,
        type: "model.call.started",
      },
      modelContext,
    );
    await provider.events["model.call.failed"](
      {
        error: new Error("model exploded"),
        idempotencyKey: "model:attempt-0:0",
        scope,
        type: "model.call.failed",
      },
      modelContext,
    );
    await provider.events["action.started"](
      {
        callId: "call-failing",
        idempotencyKey: "action:session-root:turn-0:call-failing",
        name: "failing-tool",
        scope,
        type: "action.started",
      },
      actionContext,
    );
    await provider.events["action.failed"](
      {
        error: new Error("tool exploded"),
        errorCode: "TOOL_FAILED",
        idempotencyKey: "action:session-root:turn-0:call-failing",
        outcome: "failed",
        scope,
        type: "action.failed",
      },
      actionContext,
    );
    await provider.events["turn.failed"](
      {
        error: new Error("turn exploded"),
        idempotencyKey: "turn:session-root:turn-0",
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.failed",
      },
      turnContext,
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(
      spans.find((span) => span.span_attributes?.name === "eve.step")?.error,
    ).toContain("model exploded");
    expect(
      spans.find((span) => span.span_attributes?.name === "failing-tool")
        ?.error,
    ).toContain("tool exploded");
    expect(
      spans.find((span) => span.span_attributes?.name === "eve.turn")?.error,
    ).toContain("turn exploded");
  });

  it("projects model input without provider-private fields", async () => {
    const provider = braintrustEveInstrumentation();
    const turnContext = providerContext();
    const modelContext = providerContext();

    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      turnContext,
    );
    await provider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-0:0",
        input: {
          instructions: {
            content: "Object system instruction",
            providerOptions: { encrypted: "instruction-secret" },
            role: "system",
          },
          messages: [
            {
              content: "Hello",
              providerOptions: { reasoning_details: "message-secret" },
              role: "user",
            },
            {
              content: [
                {
                  providerOptions: { encrypted: "part-secret" },
                  text: "Thinking",
                  type: "reasoning",
                },
                {
                  input: { query: "Eve" },
                  providerOptions: { encrypted: "tool-secret" },
                  toolCallId: "call-0",
                  toolName: "search",
                  type: "tool-call",
                },
                {
                  providerOptions: { encrypted: "custom-secret" },
                  type: "custom",
                },
              ],
              providerOptions: { reasoning_details: "assistant-secret" },
              role: "assistant",
            },
          ],
        },
        model: { modelId: "gpt-5.4-mini", provider: "openai.responses" },
        scope: ATTEMPT_SCOPE,
        type: "model.call.started",
      },
      modelContext,
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const step = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );
    expect(step?.input).toEqual([
      { content: "Object system instruction", role: "system" },
      { content: "Hello", role: "user" },
      {
        content: [
          { text: "Thinking", type: "reasoning" },
          {
            input: { query: "Eve" },
            toolCallId: "call-0",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ]);
    expect(JSON.stringify(step?.input)).not.toContain("providerOptions");
    expect(JSON.stringify(step?.input)).not.toContain("secret");
  });

  it("converts inline model and tool-result media to attachments", async () => {
    const provider = braintrustEveInstrumentation();
    const actionContext = providerContext();
    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      providerContext(),
    );
    await provider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-0:0",
        input: {
          messages: [
            {
              content: [
                {
                  data: "AQID",
                  filename: "tiny.png",
                  mediaType: "image/png",
                  type: "file",
                },
                {
                  image: "DQ4P",
                  mediaType: "image/png",
                  type: "image",
                },
                {
                  data: "not valid base64!",
                  filename: "invalid.png",
                  mediaType: "image/png",
                  type: "file",
                },
              ],
              role: "user",
            },
            {
              content: [
                {
                  output: {
                    type: "content",
                    value: [
                      {
                        data: "BAUG",
                        mediaType: "image/png",
                        type: "image-data",
                      },
                    ],
                  },
                  toolCallId: "call-image",
                  toolName: "render",
                  type: "tool-result",
                },
              ],
              role: "tool",
            },
          ],
        },
        model: { modelId: "gpt-5.4-mini", provider: "openai.responses" },
        scope: ATTEMPT_SCOPE,
        type: "model.call.started",
      },
      providerContext(),
    );
    await provider.events["action.started"](
      {
        callId: "call-render",
        idempotencyKey: "action:session-root:turn-0:call-render",
        input: {
          data: "data:image/png;base64,BwgJ",
          mediaType: "image/png",
          type: "file",
        },
        name: "render",
        scope: ATTEMPT_SCOPE,
        type: "action.started",
      },
      actionContext,
    );
    await provider.events["action.completed"](
      {
        idempotencyKey: "action:session-root:turn-0:call-render",
        output: {
          output: {
            type: "content",
            value: [
              {
                data: new Uint8Array([10, 11, 12]),
                mediaType: "image/png",
                type: "image-data",
              },
            ],
          },
          type: "result",
        },
        scope: ATTEMPT_SCOPE,
        type: "action.completed",
      },
      actionContext,
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const step = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );
    const inputAttachment = step?.input?.[0]?.content?.[0]?.data;
    const imageAttachment = step?.input?.[0]?.content?.[1]?.image;
    const unconvertedFile = step?.input?.[0]?.content?.[2]?.data;
    const outputAttachment =
      step?.input?.[1]?.content?.[0]?.output?.value?.[0]?.data;
    const action = spans.find(
      (span) => span.span_attributes?.name === "render",
    );
    const actionInputAttachment = action?.input?.data;
    const actionOutputAttachment = action?.output?.value?.[0]?.data;
    expect(inputAttachment).toBeInstanceOf(Attachment);
    expect(inputAttachment.reference).toMatchObject({
      content_type: "image/png",
      filename: "tiny.png",
      type: "braintrust_attachment",
    });
    expect(imageAttachment).toBeInstanceOf(Attachment);
    expect(imageAttachment.reference).toMatchObject({
      content_type: "image/png",
      type: "braintrust_attachment",
    });
    expect(unconvertedFile).toBe("not valid base64!");
    expect(outputAttachment).toBeInstanceOf(Attachment);
    expect(outputAttachment.reference).toMatchObject({
      content_type: "image/png",
      filename: "attachment.png",
      type: "braintrust_attachment",
    });
    expect(actionInputAttachment).toBeInstanceOf(Attachment);
    expect(actionInputAttachment.reference).toMatchObject({
      content_type: "image/png",
      type: "braintrust_attachment",
    });
    expect(actionOutputAttachment).toBeInstanceOf(Attachment);
    expect(actionOutputAttachment.reference).toMatchObject({
      content_type: "image/png",
      type: "braintrust_attachment",
    });
    expect(JSON.stringify(step?.input)).not.toContain("AQID");
    expect(JSON.stringify(step?.input)).not.toContain("BAUG");
  });

  it("preserves arbitrary action outputs with type fields", async () => {
    const provider = braintrustEveInstrumentation();
    const actionContext = providerContext();
    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      providerContext(),
    );
    await provider.events["action.started"](
      {
        callId: "call-text",
        idempotencyKey: "action:session-root:turn-0:call-text",
        name: "text-result",
        scope: ATTEMPT_SCOPE,
        type: "action.started",
      },
      actionContext,
    );
    await provider.events["action.completed"](
      {
        idempotencyKey: "action:session-root:turn-0:call-text",
        output: {
          output: { text: "preserve me", type: "text" },
          type: "result",
        },
        scope: ATTEMPT_SCOPE,
        type: "action.completed",
      },
      actionContext,
    );

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(
      spans.find((span) => span.span_attributes?.name === "text-result")
        ?.output,
    ).toEqual({ text: "preserve me", type: "text" });
  });

  it.each([
    ["step.attempt.completed", undefined],
    ["step.attempt.failed", new Error("attempt exploded")],
  ] as const)("closes an open model span on %s", async (type, error) => {
    const provider = braintrustEveInstrumentation();
    await provider.events["turn.started"](
      {
        idempotencyKey: "turn:session-root:turn-0",
        rootSessionId: "session-root",
        sequence: 0,
        sessionId: "session-root",
        turnId: "turn-0",
        type: "turn.started",
      },
      providerContext(),
    );
    await provider.events["model.call.started"](
      {
        idempotencyKey: "model:attempt-0:0",
        model: { modelId: "gpt-5.4-mini", provider: "openai.responses" },
        scope: ATTEMPT_SCOPE,
        type: "model.call.started",
      },
      providerContext(),
    );

    if (type === "step.attempt.completed") {
      await provider.events[type](
        {
          idempotencyKey: "step:attempt-0",
          scope: ATTEMPT_SCOPE,
          type,
        },
        providerContext(),
      );
    } else {
      await provider.events[type](
        {
          error,
          idempotencyKey: "step:attempt-0",
          scope: ATTEMPT_SCOPE,
          type,
        },
        providerContext(),
      );
    }

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const step = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );
    expect(step?.metrics?.end).toEqual(expect.any(Number));
    if (error !== undefined) {
      expect(step?.error).toContain("attempt exploded");
    }
  });
});
