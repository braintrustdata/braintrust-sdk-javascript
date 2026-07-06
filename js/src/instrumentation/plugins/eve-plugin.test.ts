import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { braintrustEveHook } from "./eve-plugin";
import type {
  EveHandleMessageStreamEvent,
  EveHookContext,
} from "../../vendor-sdk-types/eve";

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
      "eve.model.id": "eve-mock/braintrust-eve-mock",
      model: "braintrust-eve-mock",
      provider: "eve-mock",
    };

    emit({
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
    emit({
      data: { sequence: 0, turnId: "turn-flat-tree" },
      meta: { at: "2026-01-01T00:00:00.010Z" },
      type: "turn.started",
    });
    emit({
      data: {
        message: "Search then read",
        sequence: 0,
        turnId: "turn-flat-tree",
      },
      meta: { at: "2026-01-01T00:00:00.020Z" },
      type: "message.received",
    });
    emit({
      data: { sequence: 0, stepIndex: 0, turnId: "turn-flat-tree" },
      meta: { at: "2026-01-01T00:00:00.030Z" },
      type: "step.started",
    });
    emit({
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
    emit({
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
    emit({
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
    emit({
      data: { sequence: 0, stepIndex: 1, turnId: "turn-flat-tree" },
      meta: { at: "2026-01-01T00:00:00.070Z" },
      type: "step.started",
    });
    emit({
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
    emit({
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
    emit({
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
    const steps = spans
      .filter((span) =>
        String(span.span_attributes?.name).startsWith("eve.step"),
      )
      .sort(
        (left, right) =>
          Number(left.metadata?.["eve.step.index"]) -
          Number(right.metadata?.["eve.step.index"]),
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
        "eve.agent.name": "eve-test-agent",
        "eve.channel.kind": "http",
        "eve.session.id": "session-flat-tree",
        "eve.turn.id": "turn-flat-tree",
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
    for (const [index, step] of steps.entries()) {
      expect(step.metadata).toMatchObject({
        ...expectedModelMetadata,
        "eve.step.index": index,
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
        content: { hits: ["eve.dev/docs"] },
        name: "search",
        role: "tool",
        tool_call_id: "call-search",
      },
    ]);
    expect(tool).toMatchObject({
      input: { query: "Eve instrumentation" },
      metadata: {
        "eve.step.index": 0,
        "eve.tool.call_id": "call-search",
        "eve.tool.name": "search",
      },
      output: { hits: ["eve.dev/docs"] },
      span_attributes: {
        name: "search",
        type: "tool",
      },
      span_parents: [root?.span_id],
    });
    expect(tool?.metadata).not.toHaveProperty("eve.model.id");
    expect(tool?.metadata).not.toHaveProperty("model");
    expect(tool?.metadata).not.toHaveProperty("provider");
    expect(steps[0]?.output).toMatchObject({
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
    });
    expect(steps[1]?.output).toMatchObject({
      finish_reason: "stop",
      message: {
        content: "Here is the Eve instrumentation guide.",
        role: "assistant",
      },
    });
  });

  it("does not throw when Eve emits malformed events or failures", async () => {
    const wildcard = braintrustEveHook().events?.["*"];
    expect(wildcard).toBeDefined();

    expect(() => wildcard?.({ bad: true } as never, {})).not.toThrow();
    expect(() =>
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
    ).not.toThrow();
    expect(() =>
      wildcard?.(
        {
          data: { runtime: { modelId: 123 } },
          type: "session.started",
        } as never,
        { session: { id: "session-malformed-runtime" } },
      ),
    ).not.toThrow();

    const spans = await backgroundLogger.drain();
    expect(spans).toEqual([]);
  });
});
