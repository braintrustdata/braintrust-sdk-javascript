import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BackgroundLogEvent } from "../../../util/index";
import {
  _exportsForTestingOnly,
  initLogger,
  type TestBackgroundLogger,
} from "../../logger";
import { configureNode } from "../../node/config";
import type {
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryOptions,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";
import { wrapClaudeAgentSDK } from "../../wrappers/claude-agent-sdk/claude-agent-sdk";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

type ControlledStream<T> = {
  finish: () => void;
  push: (value: T) => void;
  stream: AsyncIterableIterator<T>;
};

type CapturedSpanEvent = BackgroundLogEvent & {
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
  span_attributes?: Record<string, unknown>;
  span_id?: string;
  span_parents?: string[];
};

function isCapturedSpanEvent(
  event: BackgroundLogEvent,
): event is CapturedSpanEvent {
  return "span_attributes" in event;
}

function makeControlledStream<T>(): ControlledStream<T> {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let done = false;

  return {
    finish() {
      done = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
    push(value) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        queue.push(value);
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        const value = queue.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false as const, value });
        }
        if (done) {
          return Promise.resolve({ done: true as const, value: undefined });
        }
        return new Promise((resolve) => waiters.push(resolve));
      },
    },
  };
}

function assistantToolUseMessage(options: {
  messageId: string;
  parentToolUseId: string | null;
  toolName: string;
  toolUseId: string;
}): ClaudeAgentSDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: options.parentToolUseId,
    message: {
      id: options.messageId,
      role: "assistant",
      model: "claude-scripted",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        {
          type: "tool_use",
          id: options.toolUseId,
          name: options.toolName,
          input:
            options.toolName === "Task"
              ? {
                  subagent_type: "metadata-checker",
                  description: "Metadata check",
                  prompt: "Check the metadata fields.",
                }
              : { field: "company" },
        },
      ],
    },
  };
}

function assistantTextMessage(
  model: string,
  parentToolUseId: string | null,
  inputTokens: number,
): ClaudeAgentSDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: {
      id: model,
      role: "assistant",
      model,
      content: [{ type: "text", text: model }],
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  };
}

function streamEvents(
  messageId: string,
  parentToolUseId: string | null,
  inputTokens: number,
  outputTokens: number,
): ClaudeAgentSDKMessage[] {
  return [
    {
      type: "stream_event",
      parent_tool_use_id: parentToolUseId,
      event: {
        type: "message_start",
        message: {
          id: messageId,
          usage: { input_tokens: inputTokens, output_tokens: 1 },
        },
      },
    },
    {
      type: "stream_event",
      parent_tool_use_id: parentToolUseId,
      event: {
        type: "message_delta",
        usage: { output_tokens: outputTokens },
      },
    },
  ];
}

const delegatedResultMessage: ClaudeAgentSDKMessage = {
  type: "result",
  usage: { input_tokens: 100, output_tokens: 50 },
  modelUsage: {
    "claude-sonnet-4-5": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.1,
    },
    "claude-haiku-4-5": {
      inputTokens: 200,
      outputTokens: 70,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.025,
    },
  },
  total_cost_usd: 0.125,
};

describe("Claude Agent SDK streaming instrumentation", () => {
  let backgroundLogger: TestBackgroundLogger;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectId: "test-project-id",
      projectName: "claude-agent-sdk-plugin.streaming.test.ts",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  async function runQuery(
    messages: ClaudeAgentSDKMessage[],
    options: ClaudeAgentSDKQueryOptions = {},
  ) {
    const originalMessages = structuredClone(messages);
    const sdk = wrapClaudeAgentSDK({
      async *query(_params: ClaudeAgentSDKQueryParams) {
        yield* messages;
      },
    });
    const received = [];
    for await (const message of sdk.query({ options })) {
      received.push(message);
    }
    expect(received).toEqual(originalMessages);
    const events = (await backgroundLogger.drain()).filter(isCapturedSpanEvent);
    return {
      root: events.find(
        (event) => event.span_attributes?.name === "Claude Agent",
      ),
      llms: events.filter((event) => event.span_attributes?.type === "llm"),
    };
  }

  it("aggregates delegated usage on the task span without partial messages", async () => {
    const messages = [
      assistantTextMessage("claude-sonnet-4-5", null, 100),
      assistantTextMessage("claude-haiku-4-5", "task-1", 200),
      delegatedResultMessage,
    ];
    const { root, llms } = await runQuery(messages, {
      model: "claude-sonnet-4-5",
    });

    expect(root?.metadata?.model).toBe("claude-sonnet-4-5");
    expect(root?.metadata?.total_cost_usd).toBeUndefined();
    expect(root?.metrics).toMatchObject({
      prompt_tokens: 300,
      completion_tokens: 120,
      tokens: 420,
      estimated_cost: 0.125,
    });
    expect(llms).toHaveLength(2);
    for (const llm of llms) {
      expect(llm.metrics?.tokens).toBeUndefined();
    }
  });

  it("reports unstreamed sub-agent usage on the task span with partial messages", async () => {
    const messages = [
      ...streamEvents("claude-sonnet-4-5-20250929", null, 100, 50),
      assistantTextMessage("claude-sonnet-4-5-20250929", null, 100),
      assistantTextMessage("claude-haiku-4-5-20251001", "task-1", 200),
      delegatedResultMessage,
    ];
    const { root, llms } = await runQuery(messages, {
      model: "claude-sonnet-4-5",
      includePartialMessages: true,
    });

    expect(root?.metadata).toMatchObject({
      model: "claude-sonnet-4-5",
      total_cost_usd: 0.125,
    });
    expect(root?.metrics).toMatchObject({
      completion_tokens: 70,
      tokens: 70,
      // The sub-agent's unlogged share of its model cost, weighting output tokens 5x.
      estimated_cost: expect.closeTo((0.025 * 350) / 550, 10),
    });
    expect(root?.metrics?.prompt_tokens).toBeUndefined();
    expect(llms.map((llm) => llm.metrics)).toEqual([
      expect.objectContaining({
        prompt_tokens: 100,
        completion_tokens: 50,
        tokens: 150,
      }),
      expect.not.objectContaining({ completion_tokens: expect.anything() }),
    ]);
    expect(llms[1].metrics?.prompt_tokens).toBe(200);
  });

  it("does not count streamed usage again on the task span", async () => {
    const { root } = await runQuery(
      [
        ...streamEvents("claude-sonnet-4-5-20250929", null, 100, 50),
        assistantTextMessage("claude-sonnet-4-5-20250929", null, 100),
        ...streamEvents("claude-haiku-4-5-20251001", "task-1", 200, 70),
        assistantTextMessage("claude-haiku-4-5-20251001", "task-1", 200),
        delegatedResultMessage,
      ],
      { includePartialMessages: true },
    );

    expect(root?.metrics?.prompt_tokens).toBeUndefined();
    expect(root?.metrics?.completion_tokens).toBeUndefined();
    expect(root?.metrics?.tokens).toBeUndefined();
    expect(root?.metrics?.estimated_cost).toBeUndefined();
  });

  it.each([
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5@20251001",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  ])("matches streamed usage to the %s model usage", async (modelUsageKey) => {
    const { root } = await runQuery(
      [
        ...streamEvents("claude-haiku-4-5-20251001", null, 100, 50),
        assistantTextMessage("claude-haiku-4-5-20251001", null, 100),
        {
          type: "result",
          modelUsage: {
            [modelUsageKey]: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0.01,
            },
          },
        },
      ],
      { includePartialMessages: true },
    );

    expect(root?.metrics?.tokens).toBeUndefined();
    expect(root?.metrics?.estimated_cost).toBeUndefined();
  });

  it.each([{ resume: "session-1" }, { continue: true }])(
    "ignores the restored session usage when resuming with %j",
    async (options) => {
      const { root } = await runQuery([delegatedResultMessage], options);

      expect(root?.metrics).toMatchObject({
        prompt_tokens: 100,
        completion_tokens: 50,
        tokens: 150,
      });
      expect(root?.metrics?.estimated_cost).toBeUndefined();
    },
  );

  it("ignores the restored session usage when resuming with partial messages", async () => {
    const { root } = await runQuery(
      [
        ...streamEvents("claude-sonnet-4-5", null, 100, 50),
        assistantTextMessage("claude-sonnet-4-5", null, 100),
        delegatedResultMessage,
      ],
      { resume: "session-1", includePartialMessages: true },
    );

    expect(root?.metadata?.total_cost_usd).toBeUndefined();
    expect(root?.metrics?.tokens).toBeUndefined();
    expect(root?.metrics?.estimated_cost).toBeUndefined();
  });

  it("uses all-agent usage when forking a resumed session", async () => {
    const { root } = await runQuery([delegatedResultMessage], {
      resume: "session-1",
      forkSession: true,
    });

    expect(root?.metrics).toMatchObject({
      prompt_tokens: 300,
      completion_tokens: 120,
      estimated_cost: 0.125,
    });
  });

  it.each([undefined, {}])(
    "falls back to result usage when model usage is %j",
    async (modelUsage) => {
      const { root } = await runQuery([
        {
          type: "result",
          modelUsage,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);

      expect(root?.metrics).toMatchObject({
        prompt_tokens: 10,
        completion_tokens: 5,
        tokens: 15,
      });
    },
  );

  it("uses model usage cache totals instead of the main-agent TTL breakdown", async () => {
    const { root } = await runQuery([
      {
        type: "result",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 20,
          },
        },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 50,
            costUSD: 0.01,
          },
        },
      },
    ]);
    const metrics = root?.metrics;

    expect(metrics).toMatchObject({
      prompt_tokens: 60,
      completion_tokens: 5,
      tokens: 65,
      prompt_cache_creation_tokens: 50,
    });
    expect(metrics?.prompt_cache_creation_5m_tokens).toBeUndefined();
    expect(metrics?.prompt_cache_creation_1h_tokens).toBeUndefined();
  });

  it("parents a local tool to its subagent when execution races stream consumption", async () => {
    const controlled = makeControlledStream<ClaudeAgentSDKMessage>();
    let injectedOptions: ClaudeAgentSDKQueryOptions | undefined;
    const sdk = wrapClaudeAgentSDK({
      query: (params: ClaudeAgentSDKQueryParams) => {
        injectedOptions = params.options;
        return controlled.stream;
      },
      tool: <TArgs>(
        _name: string,
        _description: string,
        _schema: unknown,
        handler: (args: TArgs, ...extra: unknown[]) => unknown,
      ) => ({ handler }),
      createSdkMcpServer: (config: { name: string; tools: unknown[] }) => ({
        type: "sdk" as const,
        name: config.name,
        instance: {},
      }),
    });

    const getMetadata = sdk.tool(
      "get_metadata",
      "Returns a synthetic metadata field.",
      { field: "string" },
      async ({ field }: { field: string }) => ({
        content: [{ type: "text", text: JSON.stringify({ field }) }],
      }),
    );
    const server = sdk.createSdkMcpServer({
      name: "skillrepro",
      tools: [getMetadata],
    });
    const result = sdk.query({
      prompt: "Delegate metadata checking to a subagent.",
      options: {
        model: "claude-scripted",
        mcpServers: { skillrepro: server },
      },
    });
    const iterator = result[Symbol.asyncIterator]();

    const taskToolUseId = "toolu_task_1";
    const localToolUseId = "toolu_mcp_before_consumption";
    const agentId = "agent-metadata-checker";

    controlled.push(
      assistantToolUseMessage({
        messageId: "msg_orchestrator",
        parentToolUseId: null,
        toolName: "Task",
        toolUseId: taskToolUseId,
      }),
    );
    await iterator.next();
    controlled.push({
      type: "system",
      subtype: "task_started",
      task_id: agentId,
      tool_use_id: taskToolUseId,
      description: "Metadata check",
      prompt: "Check the metadata fields.",
      task_type: "local_agent",
    });
    await iterator.next();

    for (const matcher of injectedOptions?.hooks?.PreToolUse ?? []) {
      for (const hook of matcher.hooks) {
        await hook(
          {
            hook_event_name: "PreToolUse",
            agent_id: agentId,
            cwd: "/test",
            session_id: "scripted-session",
            tool_input: { field: "company" },
            tool_name: "mcp__skillrepro__get_metadata",
            transcript_path: "/test/transcript.jsonl",
          },
          localToolUseId,
          { signal: new AbortController().signal },
        );
      }
    }

    // Reproduce SDK-222: the local handler starts before the application pulls
    // the subagent assistant message containing this tool-use ID.
    const localToolResult = getMetadata.handler(
      { field: "company" },
      { _meta: { "claudecode/toolUseId": localToolUseId } },
    );
    await localToolResult;

    controlled.push(
      assistantToolUseMessage({
        messageId: "msg_subagent",
        parentToolUseId: taskToolUseId,
        toolName: "mcp__skillrepro__get_metadata",
        toolUseId: localToolUseId,
      }),
    );
    await iterator.next();

    controlled.push({
      type: "result",
      num_turns: 2,
      session_id: "scripted-session",
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    await iterator.next();
    controlled.finish();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });

    const events = (await backgroundLogger.drain()).filter(isCapturedSpanEvent);
    const subagentSpan = events.find((event) =>
      String(event.span_attributes?.name).startsWith("Agent: "),
    );
    const toolSpan = events.find(
      (event) =>
        event.span_attributes?.name === "tool: skillrepro/get_metadata" &&
        event.metadata?.["gen_ai.tool.call.id"] === localToolUseId,
    );

    expect(subagentSpan).toBeDefined();
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.span_parents).toEqual([subagentSpan?.span_id]);
  });
});
