import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { configureNode } from "../../node/config";
import {
  _exportsForTestingOnly,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import { braintrustEveHook } from "./eve-plugin";
import type {
  EveHandleMessageStreamEvent,
  EveHookContext,
} from "../../vendor-sdk-types/eve";

function deterministicEveIdForTest(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("\0"))
    .digest("hex")
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
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

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("braintrust.eve.bridge"));
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "eve-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("braintrust.eve.bridge"));
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("returns an Eve hook definition", () => {
    const hook = braintrustEveHook();

    expect(Object.keys(hook)).toEqual(["events"]);
    expect(typeof hook.events?.["*"]).toBe("function");
  });

  it("records a flat Eve turn with session model metadata", async () => {
    const wildcard = braintrustEveHook({
      metadata: {
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      },
    }).events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      agent: { name: "eve-test-agent" },
      channel: { kind: "http" },
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
        scenario: "eve-plugin-unit",
        testRunId: "test-run-flat-tree",
      });
    }
    expect(steps[0]?.input).toEqual([
      { content: "Search then read", role: "user" },
    ]);
    expect(steps[1]?.input).toMatchObject([
      { content: "Search then read", role: "user" },
      {
        content: null,
        role: "assistant",
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
      {
        content: JSON.stringify({ hits: ["eve.dev/docs"] }),
        name: "search",
        role: "tool",
        tool_call_id: "call-search",
      },
    ]);
    expect(tool).toMatchObject({
      input: { query: "Eve instrumentation" },
      metadata: {
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

  it("merges incremental tool call requests into one assistant message", async () => {
    const wildcard = braintrustEveHook().events?.["*"];
    expect(wildcard).toBeDefined();

    const ctx: EveHookContext = {
      agent: { name: "eve-test-agent" },
      channel: { kind: "http" },
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
            { id: "call-search", function: { name: "search" } },
            { id: "call-read", function: { name: "read" } },
          ],
        },
      },
    ]);
    const assistantToolMessages = steps[1]?.input.filter(
      (message: Record<string, any>) =>
        message.role === "assistant" && Array.isArray(message.tool_calls),
    );
    expect(assistantToolMessages).toHaveLength(1);
    expect(assistantToolMessages?.[0]).toMatchObject({
      content: null,
      role: "assistant",
      tool_calls: [
        { id: "call-search", function: { name: "search" }, type: "function" },
        { id: "call-read", function: { name: "read" }, type: "function" },
      ],
    });
  });

  it("uses deterministic ids and nests local subagent sessions from Eve lineage", async () => {
    const wildcard = braintrustEveHook().events?.["*"];
    expect(wildcard).toBeDefined();

    const parentCtx: EveHookContext = {
      agent: { name: "eve-parent-agent" },
      channel: { kind: "http" },
      session: { id: "session-parent" },
    };
    const childCtx: EveHookContext = {
      agent: { name: "eve-child-agent", nodeId: "researcher-node" },
      channel: { kind: "subagent" },
      session: {
        id: "session-child",
        parent: {
          callId: "call-researcher",
          rootSessionId: "session-parent",
          sessionId: "session-parent",
          turn: { id: "turn-parent", sequence: 0 },
        },
      },
    };
    const emitParent = (event: EveHandleMessageStreamEvent) =>
      wildcard?.(event, parentCtx);
    const emitChild = (event: EveHandleMessageStreamEvent) =>
      wildcard?.(event, childCtx);

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
        stepIndex: 0,
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
        stepIndex: 0,
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
      data: { sequence: 0, stepIndex: 0, turnId: "turn-parent" },
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
        stepIndex: 0,
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
        stepIndex: 0,
        turnId: "turn-parent",
      },
      type: "action.result",
    });
    await emitParent({
      data: {
        finishReason: "tool-calls",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-parent",
      },
      type: "step.completed",
    });
    await emitParent({
      data: { sequence: 0, stepIndex: 1, turnId: "turn-parent" },
      type: "step.started",
    });
    await emitParent({
      data: {
        finishReason: "stop",
        message: "Parent used the child result.",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-parent",
      },
      type: "message.completed",
    });
    await emitParent({
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 1,
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
    expect(childTurn).toBeDefined();
    expect(childSearch).toBeDefined();
    expect(parentRead).toBeDefined();
    expect(parentSteps).toHaveLength(3);
    expect(parentTurn?.span_parents ?? []).toEqual([]);
    expect(parentTurn?.span_id).toBe(parentTurnId);
    expect(parentTurn?.span_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(parentTurn?.root_span_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(subagentSpans[0]?.span_parents).toEqual([parentTurn?.span_id]);
    expect(childTurn?.span_parents).toEqual([subagentSpans[0]?.span_id]);
    expect(childTurn?.root_span_id).toBe(parentTurn?.root_span_id);
    expect(childTurn?.metadata ?? {}).toEqual({});
    expect(subagentSpans[0]?.metadata ?? {}).toEqual({});
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

    Reflect.deleteProperty(globalThis, Symbol.for("braintrust.eve.bridge"));
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "eve-plugin.test.ts",
      projectId: "test-project-id",
    });
    const replay = braintrustEveHook().events?.["*"];
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
      replaySpans.find((span) => span.span_attributes?.name === "eve.turn")
        ?.span_id,
    ).toBe(parentTurn?.span_id);
  });

  it("parents root Eve turns under the active Braintrust span", async () => {
    const wildcard = braintrustEveHook().events?.["*"];
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
    expect(turn?.span_parents).toEqual([parent.spanId]);
    expect(turn?.root_span_id).toBe(parent.rootSpanId);
  });

  it("does not throw when Eve emits malformed events or failures", async () => {
    const wildcard = braintrustEveHook().events?.["*"];
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

    const spans = await backgroundLogger.drain();
    expect(spans).toEqual([]);
  });
});
