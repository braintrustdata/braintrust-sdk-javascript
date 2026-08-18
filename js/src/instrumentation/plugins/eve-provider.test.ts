import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as braintrustExports from "../../exports";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import type {
  EveJsonValue,
  EveProviderContext,
} from "../../vendor-sdk-types/eve";
import { mergeRowBatch } from "../../../util/index";
import * as instrumentationExports from "../index";
import { braintrustEveInstrumentation } from "./eve-instrumentation";

function providerContext(): EveProviderContext {
  let value: EveJsonValue | undefined;
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

describe("braintrustEveInstrumentation provider lifecycle", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "eve-provider.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("exports an Eve content provider from public entrypoints", () => {
    const setup = () => undefined;
    const instrumentation = braintrustEveInstrumentation({ setup });
    expect(instrumentation).toMatchObject({
      capture: "content",
      setup,
    });
    expect(
      Reflect.get(instrumentation, Symbol.for("eve.instrumentation.provider")),
    ).toBe(true);
    expect(braintrustExports.braintrustEveInstrumentation).toBe(
      braintrustEveInstrumentation,
    );
    expect(instrumentationExports.braintrustEveInstrumentation).toBe(
      braintrustEveInstrumentation,
    );
    expect(braintrustExports).not.toHaveProperty("braintrustEveProvider");
    expect(instrumentationExports).not.toHaveProperty("braintrustEveProvider");
  });

  it("records durable task, model, and action spans", async () => {
    const provider = braintrustEveInstrumentation({
      metadata: { scenario: "eve-provider-unit" },
    });
    const turnContext = providerContext();
    const modelContext = providerContext();
    const actionContext = providerContext();
    const scope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      rootSessionId: "session-1",
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };

    await provider.events?.["turn.started"]?.(
      {
        idempotencyKey: "turn:session-1:turn-1",
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      },
      turnContext,
    );
    await provider.events?.["model.call.started"]?.(
      {
        idempotencyKey: "model:session-1:turn-1:0:0:0",
        input: {
          instructions: "Be concise",
          messages: [{ content: "Find Eve", role: "user" }],
        },
        model: { modelId: "qwen/qwen3", provider: "openrouter" },
        scope,
        type: "model.call.started",
      },
      modelContext,
    );

    // A terminal can run in a replacement process with only Eve's durable
    // operation state available.
    const replacement = braintrustEveInstrumentation({
      metadata: { scenario: "eve-provider-unit" },
    });
    await replacement.events?.["model.call.completed"]?.(
      {
        content: [
          { text: "Thinking", type: "reasoning" },
          {
            callId: "call-search",
            input: { query: "Eve" },
            toolName: "search",
            type: "tool-call",
          },
        ],
        finishReason: "tool-calls",
        idempotencyKey: "model:session-1:turn-1:0:0:0",
        scope,
        type: "model.call.completed",
        usage: {
          inputTokenDetails: {
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
          },
          inputTokens: 10,
          outputTokens: 5,
        },
      },
      modelContext,
    );
    await provider.events?.["action.started"]?.(
      {
        callId: "call-search",
        idempotencyKey: "action:session-1:turn-1:call-search",
        input: { query: "Eve" },
        kind: "tool-call",
        name: "search",
        scope,
        type: "action.started",
      },
      actionContext,
    );
    const replayedActionContext = providerContext();
    await provider.events?.["action.started"]?.(
      {
        callId: "call-search",
        idempotencyKey: "action:session-1:turn-1:call-search",
        input: { query: "Eve" },
        kind: "tool-call",
        name: "search",
        scope,
        type: "action.started",
      },
      replayedActionContext,
    );
    await provider.events?.["action.completed"]?.(
      {
        acceptedAtMs: Date.now(),
        idempotencyKey: "action:session-1:turn-1:call-search",
        outcome: "completed",
        output: { output: { title: "Eve" }, type: "result" },
        scope,
        type: "action.completed",
      },
      actionContext,
    );
    await provider.events?.["action.failed"]?.(
      {
        error: new Error("stale terminal replay"),
        errorCode: "ACTION_CANCELLED",
        idempotencyKey: "action:session-1:turn-1:call-search",
        outcome: "cancelled",
        scope,
        type: "action.failed",
      },
      replayedActionContext,
    );
    await replacement.events?.["turn.completed"]?.(
      {
        idempotencyKey: "turn:session-1:turn-1",
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.completed",
      },
      turnContext,
    );

    const writes = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const spans = mergeRowBatch([...writes].reverse());
    const turn = spans.find(
      (span) => span.span_attributes?.name === "eve.turn",
    );
    const model = spans.find(
      (span) => span.span_attributes?.name === "eve.step",
    );
    const action = spans.find(
      (span) => span.span_attributes?.name === "search",
    );

    expect(turn).toMatchObject({
      metadata: {
        "eve.session_id": "session-1",
        scenario: "eve-provider-unit",
      },
      span_attributes: { type: "task" },
      span_parents: [],
    });
    expect(turn).not.toHaveProperty("input");
    expect(turn).not.toHaveProperty("output");
    expect(model).toMatchObject({
      input: [
        { content: "Be concise", role: "system" },
        { content: "Find Eve", role: "user" },
      ],
      metadata: {
        "eve.session_id": "session-1",
        model: "qwen/qwen3",
        provider: "openrouter",
      },
      metrics: {
        completion_tokens: 5,
        prompt_cache_creation_tokens: 4,
        prompt_cached_tokens: 3,
        prompt_tokens: 10,
        tokens: 15,
      },
      output: [
        {
          finish_reason: "tool_calls",
          message: {
            reasoning: [{ content: "Thinking" }],
            tool_calls: [
              {
                function: {
                  arguments: '{"query":"Eve"}',
                  name: "search",
                },
              },
            ],
          },
        },
      ],
      span_attributes: { type: "llm" },
      span_parents: [turn?.span_id],
    });
    expect(action).toMatchObject({
      input: { query: "Eve" },
      metadata: {
        "eve.action_kind": "tool-call",
        "eve.session_id": "session-1",
      },
      output: { title: "Eve" },
      span_attributes: { type: "tool" },
      span_parents: [turn?.span_id],
    });
    expect(action).not.toHaveProperty("error");
  });

  it("preserves the trace root for depth-two subagents after provider replacement", async () => {
    const metadata = { scenario: "eve-provider-replacement" };
    const provider = braintrustEveInstrumentation({ metadata });
    const rootContext = providerContext();
    const childContext = providerContext();
    const grandchildContext = providerContext();
    const childActionContext = providerContext();
    const grandchildActionContext = providerContext();
    const childTurn = {
      idempotencyKey: "turn:child-session:turn_0",
      parentLineage: {
        callId: "call-child",
        sessionId: "root-session",
        turnId: "turn_0",
      },
      rootSessionId: "root-session",
      sequence: 0,
      sessionId: "child-session",
      turnId: "turn_0",
      type: "turn.started" as const,
    };

    await provider.events?.["turn.started"]?.(
      {
        idempotencyKey: "turn:root-session:turn_0",
        rootSessionId: "root-session",
        sequence: 0,
        sessionId: "root-session",
        turnId: "turn_0",
        type: "turn.started",
      },
      rootContext,
    );
    await provider.events?.["action.started"]?.(
      {
        callId: "call-child",
        idempotencyKey: "action:root-session:turn_0:call-child",
        input: { message: "delegate once" },
        kind: "subagent-call",
        name: "child",
        scope: {
          attemptId: "root-attempt",
          attemptIndex: 0,
          rootSessionId: "root-session",
          sessionId: "root-session",
          stepIndex: 0,
          turnId: "turn_0",
        },
        type: "action.started",
      },
      childActionContext,
    );
    await provider.events?.["turn.started"]?.(childTurn, childContext);
    await provider.events?.["action.started"]?.(
      {
        callId: "call-grandchild",
        idempotencyKey: "action:child-session:turn_0:call-grandchild",
        input: { message: "delegate twice" },
        kind: "subagent-call",
        name: "grandchild",
        scope: {
          attemptId: "child-attempt",
          attemptIndex: 0,
          rootSessionId: "root-session",
          sessionId: "child-session",
          stepIndex: 0,
          turnId: "turn_0",
        },
        type: "action.started",
      },
      grandchildActionContext,
    );

    // The grandchild can start in a replacement process without replaying its
    // parent turn through this provider instance.
    const replacement = braintrustEveInstrumentation({ metadata });
    await replacement.events?.["turn.started"]?.(
      {
        idempotencyKey: "turn:grandchild-session:turn_0",
        parentLineage: {
          callId: "call-grandchild",
          sessionId: "child-session",
          turnId: "turn_0",
        },
        rootSessionId: "root-session",
        sequence: 0,
        sessionId: "grandchild-session",
        turnId: "turn_0",
        type: "turn.started",
      },
      grandchildContext,
    );

    const writes = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const spans = mergeRowBatch([...writes].reverse());
    const turnForSession = (sessionId: string) =>
      spans.find(
        (span) =>
          span.span_attributes?.name === "eve.turn" &&
          span.metadata?.["eve.session_id"] === sessionId,
      );
    const root = turnForSession("root-session");
    const child = turnForSession("child-session");
    const grandchild = turnForSession("grandchild-session");
    const childAction = spans.find(
      (span) => span.span_attributes?.name === "child",
    );
    const grandchildAction = spans.find(
      (span) => span.span_attributes?.name === "grandchild",
    );

    expect(root).toBeDefined();
    expect(childContext.state.get()).toMatchObject({
      exported: expect.any(String),
      rootSpanId: root?.root_span_id,
    });
    expect(child?.span_parents).toEqual([childAction?.span_id]);
    expect(child?.root_span_id).toBe(root?.root_span_id);
    expect(grandchild?.span_parents).toEqual([grandchildAction?.span_id]);
    expect(grandchild?.root_span_id).toBe(root?.root_span_id);
  });

  it("skips skill loads and contains malformed or failed lifecycle data", async () => {
    const provider = braintrustEveInstrumentation({});
    const context = providerContext();
    const scope = {
      attemptId: "attempt-failed",
      attemptIndex: 0,
      sessionId: "session-failed",
      stepIndex: 0,
      turnId: "turn-failed",
    };

    await expect(
      provider.events?.["action.started"]?.(
        {
          callId: "skill",
          idempotencyKey: "action:session-failed:turn-failed:skill",
          kind: "load-skill",
          name: "load",
          scope,
          type: "action.started",
        },
        context,
      ),
    ).resolves.toBeUndefined();
    await expect(
      provider.events?.["action.failed"]?.(
        {
          errorCode: "rejected",
          idempotencyKey: "action:session-failed:turn-failed:skill",
          outcome: "rejected",
          scope,
          type: "action.failed",
        },
        context,
      ),
    ).resolves.toBeUndefined();
    await expect(
      provider.events?.["model.call.failed"]?.(
        {
          error: new Error("model failed"),
          idempotencyKey: "missing-model",
          scope,
          type: "model.call.failed",
        },
        providerContext(),
      ),
    ).resolves.toBeUndefined();

    expect(await backgroundLogger.drain()).toEqual([]);
  });
});
