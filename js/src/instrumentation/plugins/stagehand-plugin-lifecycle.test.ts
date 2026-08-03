import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStartSpan, tracingChannels } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
  tracingChannels: new Map<string, any>(),
}));

vi.mock("../../isomorph", () => ({
  default: {
    newAsyncLocalStorage: vi.fn(() => ({
      getStore: vi.fn(() => undefined),
      run: vi.fn((_store: unknown, callback: () => unknown) => callback()),
    })),
    newTracingChannel: vi.fn((name: string) => {
      const channel = {
        start: undefined,
        subscribe: vi.fn((handlers) => tracingChannels.set(name, handlers)),
        tracePromise: vi.fn((fn: () => PromiseLike<unknown>) => fn()),
        traceSync: vi.fn((fn: () => unknown) => fn()),
        unsubscribe: vi.fn(),
      };
      return channel;
    }),
  },
}));

vi.mock("../../logger", () => ({
  BRAINTRUST_CURRENT_SPAN_STORE: Symbol.for("test.current-span-store"),
  _internalGetGlobalState: () => undefined,
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
}));

import { StagehandPlugin } from "./stagehand-plugin";

describe("StagehandPlugin lifecycle", () => {
  let spans: Array<{
    args: any;
    end: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  }>;

  beforeEach(() => {
    spans = [];
    tracingChannels.clear();
    mockStartSpan.mockImplementation((args: any) => {
      const span = { args, end: vi.fn(), log: vi.fn() };
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a streamed agent span open until the nested result settles", async () => {
    const plugin = new StagehandPlugin();
    plugin.enable();
    const handlers = tracingChannels.get(
      "orchestrion:@browserbasehq/stagehand:Agent.execute",
    );
    let resolveResult!: (value: unknown) => void;
    const nestedResult = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const event: any = {
      agentConfig: {
        apiKey: "must-not-be-captured",
        maxSteps: 8,
        mode: "dom",
        model: "browser-model",
        stream: true,
      },
      arguments: [{ instruction: "complete the task" }],
      self: {},
      stagehand: {},
    };

    handlers.start(event);
    event.result = { result: nestedResult, stream: "preserved" };
    handlers.asyncEnd(event);

    expect(spans[0].end).not.toHaveBeenCalled();
    expect(spans[0].log).toHaveBeenNthCalledWith(1, {
      input: { instruction: "complete the task" },
      metadata: {
        model: "browser-model",
        "stagehand.max_steps": 8,
        "stagehand.mode": "dom",
        "stagehand.streaming": true,
      },
    });

    resolveResult({
      actions: [{ taskCompleted: true, timeMs: 7, type: "act" }],
      completed: true,
      message: "done",
      metadata: { cacheHit: true, debugUrl: "must-not-be-captured" },
      success: true,
      usage: { input_tokens: 2, output_tokens: 3 },
    });
    await nestedResult;
    await Promise.resolve();

    expect(spans[0].log).toHaveBeenLastCalledWith({
      metadata: { "stagehand.cache_status": "hit" },
      metrics: { prompt_tokens: 2, completion_tokens: 3, tokens: 5 },
      output: {
        actions: [{ task_completed: true, time_ms: 7, type: "act" }],
        completed: true,
        message: "done",
        success: true,
      },
    });
    expect(spans[0].end).toHaveBeenCalledTimes(1);
  });

  it("logs the original Error when a streamed result rejects", async () => {
    const plugin = new StagehandPlugin();
    plugin.enable();
    const handlers = tracingChannels.get(
      "orchestrion:@browserbasehq/stagehand:Agent.execute",
    );
    const error = new Error("stream failed");
    let rejectResult!: (error: Error) => void;
    const nestedResult = new Promise((_resolve, reject) => {
      rejectResult = reject;
    });
    const event: any = {
      agentConfig: { stream: true },
      arguments: [{ instruction: "fail" }],
      result: { result: nestedResult },
      self: {},
    };

    handlers.start(event);
    handlers.asyncEnd(event);
    rejectResult(error);
    await expect(nestedResult).rejects.toBe(error);
    await Promise.resolve();

    expect(spans[0].log).toHaveBeenLastCalledWith({ error });
    expect(spans[0].end).toHaveBeenCalledTimes(1);
  });

  it("instruments the mutable agent returned by the synchronous factory", async () => {
    const plugin = new StagehandPlugin();
    plugin.enable();
    const handlers = tracingChannels.get(
      "orchestrion:@browserbasehq/stagehand:Stagehand.agent",
    );
    const originalExecute = vi.fn(async () => "complete");
    const agent = { execute: originalExecute };
    const event = {
      arguments: [{ model: "browser-model" }],
      result: agent,
      self: { llmClient: { modelName: "fallback-model" } },
    };

    handlers.end(event);
    const wrappedExecute = agent.execute;
    handlers.end(event);

    expect(agent.execute).toBe(wrappedExecute);
    await expect(agent.execute()).resolves.toBe("complete");
    expect(originalExecute).toHaveBeenCalledTimes(1);
  });
});
