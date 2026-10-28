import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";
import { invocationController } from "../test-utils/invocation";
vi.mock("../../global-instrumentation-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../global-instrumentation-hooks")
  >()),
  newGlobalInvocationHook: vi.fn(),
}));

const { mockStartSpan } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
}));

vi.mock("../../isomorph", () => ({
  default: {},
}));

vi.mock("../../debug-logger", () => ({
  debugLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
}));

import { CursorSDKPlugin } from "./cursor-sdk-plugin";
import {
  cursorAgentSDKHookEvents,
  metricsFromCursorUsage,
  resetCursorAgentSDKContext,
} from "./cursor-agent-sdk-context";

const mockNewInvocationHook = newGlobalInvocationHook as ReturnType<
  typeof vi.fn
>;

describe("CursorSDKPlugin", () => {
  let handlersByName: Map<string, any>;
  let spans: Array<{
    end: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    name?: string;
  }>;

  beforeEach(() => {
    handlersByName = new Map();
    spans = [];
    mockNewInvocationHook.mockImplementation((name: string) => ({
      intercept: vi.fn((interceptor) => {
        handlersByName.set(name, invocationController(interceptor));
        return vi.fn();
      }),
      invoke: vi.fn((fn, receiver, args) => Reflect.apply(fn, receiver, args)),
      unsubscribe: vi.fn(),
    }));
    mockStartSpan.mockImplementation((args: any) => {
      const span = {
        end: vi.fn(),
        export: vi.fn(async () => `${args.name}-export-${spans.length}`),
        log: vi.fn(),
        spanId: `span-${spans.length}`,
        name: args.name,
      };
      if (args.event) {
        span.log(args.event);
      }
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    resetCursorAgentSDKContext();
    vi.clearAllMocks();
  });

  it("subscribes to Cursor SDK channels", () => {
    const plugin = new CursorSDKPlugin();

    plugin.enable();

    expect(handlersByName.has("orchestrion:@cursor/sdk:Agent.create")).toBe(
      true,
    );
    expect(handlersByName.has("orchestrion:@cursor/sdk:Agent.resume")).toBe(
      true,
    );
    expect(handlersByName.has("orchestrion:@cursor/sdk:Agent.prompt")).toBe(
      true,
    );
    expect(handlersByName.has("orchestrion:@cursor/sdk:agent.send")).toBe(true);
  });

  it("patches agents returned by Agent.create and traces send/wait", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();

    const createHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:Agent.create",
    );
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun();
    const originalSend = vi.fn(async () => run);
    const agent: any = {
      agentId: "agent-1",
      send: originalSend,
    };

    createHandlers.call({
      arguments: [{ local: { cwd: "/tmp/repo" } }],
      result: agent,
    });

    const patchedRun = await agent.send("use a tool", {});
    expect(patchedRun).toBe(run);
    expect(originalSend).toHaveBeenCalledTimes(1);

    const sendEvent = {
      agent,
      arguments: ["use a tool", {}],
      result: run,
    };
    sendHandlers.begin(sendEvent);
    sendHandlers.resolve(sendEvent);

    await run.wait();

    const rootSpan = spans.find((span) => span.name === "Cursor Agent");
    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "use a tool",
        metadata: expect.objectContaining({
          "cursor_sdk.agent_id": "agent-1",
          provider: "cursor",
        }),
      }),
    );
    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "done",
        metadata: expect.objectContaining({
          "cursor_sdk.run_id": "run-1",
          "cursor_sdk.status": "finished",
        }),
      }),
    );
    expect(rootSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("captures stream tool calls and usage", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();

    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun([
      {
        type: "tool_call",
        call_id: "call-1",
        name: "shell",
        status: "running",
        args: { command: "echo hi" },
      },
      {
        type: "tool_call",
        call_id: "call-1",
        name: "shell",
        status: "completed",
        result: { stdout: "hi\n" },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      },
    ]);
    const event = {
      agent: { agentId: "agent-1" },
      arguments: [
        "hello",
        {
          onDelta: vi.fn(),
        },
      ],
      result: run,
    };

    sendHandlers.begin(event);
    await (event.arguments[1] as any).onDelta({
      update: {
        type: "turn-ended",
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
        },
      },
    });
    sendHandlers.resolve(event);

    const chunks = [];
    for await (const chunk of run.stream()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    const toolSpan = spans.find((span) => span.name === "tool: shell");
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { command: "echo hi" },
      }),
    );
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { stdout: "hi\n" },
      }),
    );
    const rootSpan = spans.find((span) => span.name === "Cursor Agent");
    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          completion_tokens: 4,
          prompt_cache_creation_tokens: 2,
          prompt_cached_tokens: 1,
          prompt_tokens: 6,
          tokens: 10,
        }),
        output: "done",
      }),
    );
  });

  it("traces Agent.prompt without a nested send span", () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();

    const promptHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:Agent.prompt",
    );
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const promptEvent = { arguments: ["hello", { local: { cwd: "/tmp" } }] };

    promptHandlers.begin(promptEvent);
    sendHandlers.begin({ arguments: ["nested", {}] });
    promptHandlers.resolve(
      Object.assign(promptEvent, {
        result: { id: "run-1", result: "done", status: "finished" },
      }),
    );

    expect(spans.filter((span) => span.name === "Cursor Agent")).toHaveLength(
      1,
    );
  });

  it("names custom MCP tools and keeps reported run usage", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun();
    run.wait = async () => ({
      id: "run-1",
      requestId: "req-1",
      result: "STAMP:BRAINTRUST_STAMP_OK",
      status: "finished",
      usage: {
        inputTokens: 9,
        outputTokens: 8,
        totalTokens: 17,
      },
    });
    const event = {
      agent: { agentId: "agent-mcp" },
      arguments: ["STAMP", { onDelta: vi.fn() }],
      result: run,
    };

    sendHandlers.begin(event);
    const onDelta = (
      event.arguments[1] as { onDelta: (args: unknown) => Promise<void> }
    ).onDelta;
    await onDelta({
      update: {
        type: "tool-call-started",
        callId: "call-stamp",
        toolCall: {
          type: "mcp",
          args: {
            providerIdentifier: "custom-user-tools",
            toolName: "stamp",
            args: { text: "BRAINTRUST_STAMP_OK" },
          },
        },
      },
    });
    await onDelta({
      update: {
        type: "tool-call-completed",
        callId: "call-stamp",
        toolCall: {
          type: "mcp",
          status: "completed",
          args: {
            providerIdentifier: "custom-user-tools",
            toolName: "stamp",
            args: { text: "BRAINTRUST_STAMP_OK" },
          },
          result: {
            status: "success",
            value: {
              content: [{ text: { text: "STAMP:BRAINTRUST_STAMP_OK" } }],
            },
          },
          truncated: { result: false },
        },
      },
    });
    await onDelta({
      update: {
        type: "turn-ended",
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    });
    sendHandlers.resolve(event);
    await run.wait();

    const toolSpan = spans.find((span) => span.name === "tool: stamp");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { text: "BRAINTRUST_STAMP_OK" },
      }),
    );
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "cursor_sdk.tool.status": "completed",
          "cursor_sdk.tool.result_truncated": false,
        }),
        output: "STAMP:BRAINTRUST_STAMP_OK",
      }),
    );
    const rootSpan = spans.find((span) => span.name === "Cursor Agent");
    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "cursor_sdk.request_id": "req-1",
          "cursor_sdk.usage_scope": "run",
        }),
        metrics: expect.objectContaining({
          prompt_tokens: 9,
          completion_tokens: 8,
          tokens: 17,
        }),
      }),
    );
    expect(rootSpan?.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({ prompt_tokens: 12 }),
      }),
    );
  });

  it("nests subagent tool deltas and does not invent a cancelled error", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun();
    run.wait = async () => ({
      id: "run-cancel",
      status: "cancelled",
    });
    const event = {
      agent: { agentId: "agent-cancel" },
      arguments: ["HANG", { onDelta: vi.fn() }],
      result: run,
    };
    sendHandlers.begin(event);
    const onDelta = (
      event.arguments[1] as { onDelta: (args: unknown) => Promise<void> }
    ).onDelta;
    await onDelta({
      update: {
        type: "tool-call-started",
        callId: "task-1",
        toolCall: {
          type: "task",
          args: {
            description: "echoer",
            subagentType: { name: "echoer" },
          },
        },
      },
    });
    await onDelta({
      update: {
        type: "tool-call-delta",
        callId: "task-1",
        taskUpdate: {
          type: "tool-call-completed",
          callId: "inner-1",
          toolCall: {
            type: "shell",
            name: "shell",
            args: { command: "echo nested" },
            result: { stdout: "nested" },
            status: "completed",
          },
        },
      },
    });
    sendHandlers.resolve(event);
    await run.wait();

    expect(spans.some((span) => span.name === "tool: task")).toBe(true);
    expect(spans.some((span) => span.name === "Agent: echoer")).toBe(true);
    expect(spans.some((span) => span.name === "tool: shell")).toBe(true);
    const rootSpan = spans.find((span) => span.name === "Cursor Agent");
    const logs = rootSpan?.log.mock.calls.map((call) => call[0]) ?? [];
    const cancelled = logs.find(
      (entry) => entry.metadata?.["cursor_sdk.status"] === "cancelled",
    );
    expect(cancelled).toBeDefined();
    expect(cancelled.error).toBeUndefined();
  });

  it("keeps concurrent Agent SDK sessions on their own spans", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const hooks = cursorAgentSDKHookEvents();
    const runA = makeRun();
    const runB = makeRun();
    runA.wait = async () => ({ id: "run-a", result: "A", status: "finished" });
    runB.wait = async () => ({ id: "run-b", result: "B", status: "finished" });
    const eventA = {
      agent: { agentId: "session-a" },
      arguments: ["A", { onDelta: vi.fn() }],
      result: runA,
    };
    const eventB = {
      agent: { agentId: "session-b" },
      arguments: ["B", { onDelta: vi.fn() }],
      result: runB,
    };
    sendHandlers.begin(eventA);
    sendHandlers.begin(eventB);
    hooks["turn.started"](
      { sessionId: "session-a", turnId: "turn-a", type: "turn.started" },
      { session: { id: "session-a", sdkAgentId: "session-a" } },
    );
    hooks["turn.started"](
      { sessionId: "session-b", turnId: "turn-b", type: "turn.started" },
      { session: { id: "session-b", sdkAgentId: "session-b" } },
    );
    hooks["turn.completed"](
      {
        data: { usage: { inputTokens: 5, outputTokens: 6 } },
        sessionId: "session-a",
        turnId: "turn-a",
        type: "turn.completed",
      },
      { session: { id: "session-a", sdkAgentId: "session-a" } },
    );
    sendHandlers.resolve(eventA);
    sendHandlers.resolve(eventB);
    await runA.wait();
    await runB.wait();

    const roots = spans.filter((span) => span.name === "Cursor Agent");
    expect(roots).toHaveLength(2);
    expect(roots[0]?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "agent_sdk.session_id": "session-a",
          "agent_sdk.turn_id": "turn-a",
        }),
      }),
    );
    expect(roots[1]?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "agent_sdk.session_id": "session-b",
          "agent_sdk.turn_id": "turn-b",
        }),
      }),
    );
    expect(roots[1]?.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "agent_sdk.turn_id": "turn-a",
        }),
      }),
    );
  });

  it("keeps hook failures inside the hook handler", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const hooks = cursorAgentSDKHookEvents();
    const run = makeRun();
    const event = {
      agent: { agentId: "session-throw" },
      arguments: ["A", {}],
      result: run,
    };
    sendHandlers.begin(event);
    spans
      .find((span) => span.name === "Cursor Agent")
      ?.log.mockImplementation(() => {
        throw new Error("log failed");
      });

    expect(() =>
      hooks["turn.started"](
        { sessionId: "session-throw", turnId: "turn-1" },
        { session: { id: "session-throw", sdkAgentId: "session-throw" } },
      ),
    ).not.toThrow();
    expect(() =>
      hooks["turn.failed"](undefined as never, undefined as never),
    ).not.toThrow();
  });

  it("shares hook state across braintrust copies", async () => {
    const before = (globalThis as Record<symbol, unknown>)[
      Symbol.for("braintrust.cursor-agent-sdk.context")
    ];
    vi.resetModules();
    await import("./cursor-agent-sdk-context");
    expect(
      (globalThis as Record<symbol, unknown>)[
        Symbol.for("braintrust.cursor-agent-sdk.context")
      ],
    ).toBe(before);
  });

  it("keeps session ids stamped before send resolves on later tool spans", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const hooks = cursorAgentSDKHookEvents();
    const run = makeRun();
    run.wait = async () => ({
      id: "run-tool",
      result: "ok",
      status: "finished",
    });
    const event = {
      agent: { agentId: "session-tool" },
      arguments: ["STAMP", { onDelta: vi.fn() }],
      result: run,
    };
    sendHandlers.begin(event);
    hooks["turn.started"](
      { sessionId: "session-tool", turnId: "turn-tool", type: "turn.started" },
      { session: { id: "session-tool", sdkAgentId: "session-tool" } },
    );
    sendHandlers.resolve(event);
    const onDelta = (
      event.arguments[1] as { onDelta: (args: unknown) => Promise<void> }
    ).onDelta;
    await onDelta({
      update: {
        callId: "stamp-1",
        toolCall: {
          args: {
            args: { text: "ok" },
            providerIdentifier: "custom-user-tools",
            toolName: "stamp",
          },
          result: {
            status: "success",
            value: { content: [{ text: { text: "STAMP:ok" } }] },
          },
          status: "completed",
          type: "mcp",
        },
        type: "tool-call-completed",
      },
    });

    const toolSpan = spans.find((span) => span.name === "tool: stamp");
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "agent_sdk.session_id": "session-tool",
          "agent_sdk.turn_id": "turn-tool",
        }),
      }),
    );
  });

  it("does not fold subagent text into the parent run output", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun();
    run.result = undefined;
    run.wait = async () => ({ id: "run-nested-text", status: "finished" });
    const event = {
      agent: { agentId: "agent-nested-text" },
      arguments: ["DELEGATE", { onDelta: vi.fn() }],
      result: run,
    };
    sendHandlers.begin(event);
    const onDelta = (
      event.arguments[1] as { onDelta: (args: unknown) => Promise<void> }
    ).onDelta;
    await onDelta({
      update: { text: "PARENT_TEXT", type: "text-delta" },
    });
    await onDelta({
      update: {
        callId: "task-1",
        toolCall: {
          args: { description: "echoer" },
          type: "task",
        },
        type: "tool-call-started",
      },
    });
    await onDelta({
      update: {
        callId: "task-1",
        taskUpdate: { text: "CHILD_TEXT", type: "text-delta" },
        type: "tool-call-delta",
      },
    });
    sendHandlers.resolve(event);
    await run.wait();

    const rootSpan = spans.find((span) => span.name === "Cursor Agent");
    const outputLog = rootSpan?.log.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.output !== undefined);
    expect(outputLog?.output).toBe("PARENT_TEXT");
    expect(outputLog?.metrics?.time_to_first_token).toEqual(expect.any(Number));
    const subAgent = spans.find((span) => span.name === "Agent: echoer");
    expect(subAgent?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          time_to_first_token: expect.any(Number),
        }),
      }),
    );
  });

  it("does not treat tool activity or a missing status as model output", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun();
    run.wait = async () => ({
      id: "run-status",
      result: "ok",
      status: "finished",
    });
    const event = {
      agent: { agentId: "agent-status" },
      arguments: ["TOOL", { onDelta: vi.fn() }],
      result: run,
    };
    sendHandlers.begin(event);
    const onDelta = (
      event.arguments[1] as { onDelta: (args: unknown) => Promise<void> }
    ).onDelta;
    await onDelta({
      update: {
        callId: "tool-1",
        toolCall: { name: "stamp", type: "stamp" },
        type: "tool-call-started",
      },
    });
    await onDelta({
      update: { tokens: 4, type: "token-delta" },
    });
    await onDelta({
      update: {
        callId: "tool-1",
        toolCall: { name: "stamp", result: "ok", type: "stamp" },
        type: "tool-call-completed",
      },
    });
    sendHandlers.resolve(event);
    await run.wait();

    const rootSpan = spans.find((span) => span.name === "Cursor Agent");
    const finish = rootSpan?.log.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.output !== undefined);
    expect(finish?.metrics?.time_to_first_token).toBeUndefined();
    expect(finish?.metadata?.["cursor_sdk.delta_tokens"]).toBe(4);
    expect(finish?.metrics?.["cursor_sdk.delta_tokens"]).toBeUndefined();
    const toolSpan = spans.find((span) => span.name === "tool: stamp");
    expect(toolSpan?.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "cursor_sdk.tool.status": "completed",
        }),
      }),
    );
  });

  it("marks tools still running at cancellation as cancelled", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun();
    run.wait = async () => ({ id: "run-hang", status: "cancelled" });
    const event = {
      agent: { agentId: "agent-hang" },
      arguments: ["HANG", { onDelta: vi.fn() }],
      result: run,
    };
    sendHandlers.begin(event);
    const onDelta = (
      event.arguments[1] as { onDelta: (args: unknown) => Promise<void> }
    ).onDelta;
    await onDelta({
      update: {
        callId: "hang-1",
        toolCall: {
          type: "mcp",
          args: { providerIdentifier: "custom-user-tools", toolName: "hang" },
        },
        type: "tool-call-started",
      },
    });
    sendHandlers.resolve(event);
    await run.wait();

    const toolSpan = spans.find((span) => span.name === "tool: hang");
    expect(toolSpan?.end).toHaveBeenCalledTimes(1);
    expect(toolSpan?.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: { "cursor_sdk.tool.status": "cancelled" },
      }),
    );
  });

  it("does not throw into the application when span logging fails", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const run = makeRun();
    const event = {
      agent: { agentId: "agent-throw" },
      arguments: ["hello", {}],
      result: run,
    };
    sendHandlers.begin(event);
    const rootSpan = spans.find((span) => span.name === "Cursor Agent");
    rootSpan?.log.mockImplementation(() => {
      throw new Error("log failed");
    });
    sendHandlers.resolve(event);

    await expect(run.wait()).resolves.toMatchObject({ status: "finished" });
    expect(rootSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("keeps an open run addressable after later turns on the same agent", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const hooks = cursorAgentSDKHookEvents();
    const openRun = makeRun();
    const openEvent = {
      agent: { agentId: "shared-agent" },
      arguments: ["open", { onDelta: vi.fn() }],
      result: openRun,
    };
    sendHandlers.begin(openEvent);
    for (let index = 0; index < 10; index += 1) {
      const run = makeRun();
      const event = {
        agent: { agentId: "shared-agent" },
        arguments: [`done-${index}`, { onDelta: vi.fn() }],
        result: run,
      };
      sendHandlers.begin(event);
      sendHandlers.resolve(event);
      await run.wait();
    }
    hooks["turn.started"](
      {
        sessionId: "shared-agent",
        turnId: "open-turn",
        type: "turn.started",
      },
      { session: { id: "shared-agent", sdkAgentId: "shared-agent" } },
    );

    const openSpan = spans.find((span) =>
      span.log.mock.calls.some((call) => call[0]?.input === "open"),
    );
    expect(openSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "agent_sdk.turn_id": "open-turn",
        }),
      }),
    );
  });

  it("evicts finished sessions while a live one is the oldest", async () => {
    const plugin = new CursorSDKPlugin();
    plugin.enable();
    const sendHandlers = handlersByName.get(
      "orchestrion:@cursor/sdk:agent.send",
    );
    const hooks = cursorAgentSDKHookEvents();
    const stamp = (agentId: string, turnId: string) => {
      hooks["turn.started"](
        { sessionId: agentId, turnId, type: "turn.started" },
        { session: { id: agentId, sdkAgentId: agentId } },
      );
    };
    const finish = async (agentId: string, input: string) => {
      const run = makeRun();
      const event = {
        agent: { agentId },
        arguments: [input, { onDelta: vi.fn() }],
        result: run,
      };
      sendHandlers.begin(event);
      sendHandlers.resolve(event);
      await run.wait();
    };

    sendHandlers.begin({
      agent: { agentId: "agent-0" },
      arguments: ["open", { onDelta: vi.fn() }],
    });
    const earlyEvent = {
      agent: { agentId: "agent-1" },
      arguments: ["early", { onDelta: vi.fn() }],
      result: makeRun(),
    };
    sendHandlers.begin(earlyEvent);
    stamp("agent-1", "turn-1");
    sendHandlers.resolve(earlyEvent);
    await earlyEvent.result.wait();

    for (let index = 2; index <= 70; index += 1) {
      await finish(`agent-${index}`, `done-${index}`);
    }
    const recent = {
      agent: { agentId: "agent-recent" },
      arguments: ["recent", { onDelta: vi.fn() }],
      result: makeRun(),
    };
    sendHandlers.begin(recent);
    stamp("agent-recent", "turn-recent");
    sendHandlers.resolve(recent);
    await recent.result.wait();
    stamp("agent-recent", "turn-recent");
    stamp("agent-1", "turn-1");
    stamp("agent-0", "turn-0");

    const spanFor = (input: string) =>
      spans.find((span) =>
        span.log.mock.calls.some((call) => call[0]?.input === input),
      );
    const turnLogs = (input: string, turnId: string) =>
      spanFor(input)?.log.mock.calls.filter(
        (call) =>
          call[0]?.input === undefined &&
          call[0]?.output === undefined &&
          call[0]?.metrics === undefined &&
          call[0]?.metadata?.["agent_sdk.turn_id"] === turnId,
      ) ?? [];
    expect(turnLogs("open", "turn-0")).toHaveLength(1);
    expect(turnLogs("early", "turn-1")).toHaveLength(1);
    expect(turnLogs("recent", "turn-recent")).toHaveLength(2);
  });
});

describe("metricsFromCursorUsage", () => {
  it("rolls disjoint cache tokens into prompt_tokens and tokens", () => {
    expect(
      metricsFromCursorUsage({
        cacheReadTokens: 7200,
        cacheWriteTokens: 0,
        inputTokens: 17728,
        outputTokens: 201,
        reasoningTokens: 40,
        totalTokens: 17929,
      }),
    ).toEqual({
      completion_reasoning_tokens: 40,
      completion_tokens: 201,
      prompt_cache_creation_tokens: 0,
      prompt_cached_tokens: 7200,
      prompt_tokens: 24928,
      tokens: 25129,
    });
  });

  it("omits cache metrics the provider did not report", () => {
    expect(
      metricsFromCursorUsage({
        inputTokens: 9,
        outputTokens: 8,
        totalTokens: 17,
      }),
    ).toEqual({
      completion_tokens: 8,
      prompt_tokens: 9,
      tokens: 17,
    });
  });
});

function makeRun(messages: unknown[] = []): any {
  return {
    agentId: "agent-1",
    async conversation() {
      return [];
    },
    id: "run-1",
    result: "done",
    status: "finished",
    stream: async function* () {
      for (const message of messages) {
        yield message;
      }
    },
    async wait() {
      return { id: "run-1", result: "done", status: "finished" };
    },
  };
}
