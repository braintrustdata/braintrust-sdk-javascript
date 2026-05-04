import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStartSpan } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
}));

vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
}));

import iso from "../../isomorph";
import { CursorSDKPlugin } from "./cursor-sdk-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

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
    mockNewTracingChannel.mockImplementation((name: string) => ({
      subscribe: vi.fn((handlers) => handlersByName.set(name, handlers)),
      tracePromise: vi.fn((fn) => fn()),
      unsubscribe: vi.fn(),
    }));
    mockStartSpan.mockImplementation((args: any) => {
      const span = {
        end: vi.fn(),
        export: vi.fn(async () => `${args.name}-export-${spans.length}`),
        log: vi.fn(),
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
    const agent = {
      agentId: "agent-1",
      send: originalSend,
    };

    createHandlers.asyncEnd({
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
    sendHandlers.start(sendEvent);
    sendHandlers.asyncEnd(sendEvent);

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

    sendHandlers.start(event);
    await event.arguments[1].onDelta({
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
    sendHandlers.asyncEnd(event);

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
          prompt_tokens: 3,
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

    promptHandlers.start(promptEvent);
    sendHandlers.start({ arguments: ["nested", {}] });
    promptHandlers.asyncEnd({
      ...promptEvent,
      result: { id: "run-1", result: "done", status: "finished" },
    });

    expect(spans.filter((span) => span.name === "Cursor Agent")).toHaveLength(
      1,
    );
  });
});

function makeRun(messages: unknown[] = []) {
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
