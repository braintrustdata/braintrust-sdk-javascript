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

  it.each([
    { partial: false, subagentStream: false },
    { partial: true, subagentStream: false },
    { partial: true, subagentStream: true },
  ])(
    "accounts for delegated usage: %j",
    async ({ partial, subagentStream }) => {
      const messages: ClaudeAgentSDKMessage[] = [];
      for (const [id, parent, input, output] of [
        ["main", null, 100, 50],
        ["subagent", "task-1", 200, 70],
      ] as const) {
        if (partial && (parent === null || subagentStream)) {
          messages.push(
            {
              type: "stream_event",
              parent_tool_use_id: parent,
              event: {
                type: "message_start",
                message: {
                  id,
                  usage: { input_tokens: input, output_tokens: 1 },
                },
              },
            },
            {
              type: "stream_event",
              parent_tool_use_id: parent,
              event: {
                type: "message_delta",
                usage: { output_tokens: output },
              },
            },
          );
        }
        messages.push({
          type: "assistant",
          parent_tool_use_id: parent,
          message: {
            id,
            role: "assistant",
            model: id,
            content: [{ type: "text", text: id }],
            usage: { input_tokens: input, output_tokens: 1 },
          },
        });
      }
      messages.push({
        type: "result",
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: {
          main: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.1,
          },
          subagent: {
            inputTokens: 200,
            outputTokens: 70,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.025,
          },
        },
      });
      const originalMessages = structuredClone(messages);
      const sdk = wrapClaudeAgentSDK({
        async *query(_params: ClaudeAgentSDKQueryParams) {
          yield* messages;
        },
      });
      const received = [];
      for await (const message of sdk.query({
        options: { includePartialMessages: partial },
      })) {
        received.push(message);
      }
      expect(received).toEqual(originalMessages);
      const events = (await backgroundLogger.drain()).filter(
        isCapturedSpanEvent,
      );
      const root = events.find(
        (event) => event.span_attributes?.name === "Claude Agent",
      );
      const llms = events.filter(
        (event) => event.span_attributes?.type === "llm",
      );
      expect(llms).toHaveLength(2);
      if (!partial) {
        expect(root?.metrics).toMatchObject({
          prompt_tokens: 300,
          completion_tokens: 120,
          tokens: 420,
        });
        for (const llm of llms) {
          expect(llm.metrics?.tokens).toBeUndefined();
        }
      } else {
        expect(root?.metrics?.tokens).toBeUndefined();
        expect(root?.metadata?.total_usage).toEqual({
          input_tokens: 300,
          output_tokens: 120,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        });
        const main = llms.find((event) => event.metadata?.model === "main");
        const subagent = llms.find(
          (event) => event.metadata?.model === "subagent",
        );
        expect(main?.metrics).toMatchObject({
          prompt_tokens: 100,
          completion_tokens: 50,
          tokens: 150,
        });
        expect(subagent?.metrics?.prompt_tokens).toBe(200);
        expect(subagent?.metrics?.completion_tokens).toBe(
          subagentStream ? 70 : undefined,
        );
        expect(subagent?.metrics?.tokens).toBe(
          subagentStream ? 270 : undefined,
        );
      }
    },
  );

  it.each<{
    name: string;
    modelUsage: ClaudeAgentSDKMessage["modelUsage"];
    expectedUsage: Record<string, number>;
    expectedMetrics: Record<string, number>;
    partial: boolean;
  }>(
    [
      {
        name: "missing",
        modelUsage: undefined,
        expectedUsage: { input_tokens: 10, output_tokens: 5 },
        expectedMetrics: {
          prompt_tokens: 10,
          completion_tokens: 5,
          tokens: 15,
        },
      },
      {
        name: "empty",
        modelUsage: {},
        expectedUsage: { input_tokens: 10, output_tokens: 5 },
        expectedMetrics: {
          prompt_tokens: 10,
          completion_tokens: 5,
          tokens: 15,
        },
      },
      {
        name: "zero",
        modelUsage: {
          zero: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
          },
        },
        expectedUsage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        expectedMetrics: { prompt_tokens: 0, completion_tokens: 0, tokens: 0 },
      },
    ].flatMap((testCase) =>
      [false, true].map((partial) => ({ ...testCase, partial })),
    ),
  )(
    "handles $name model usage with partial messages $partial",
    async ({ modelUsage, expectedUsage, expectedMetrics, partial }) => {
      const sdk = wrapClaudeAgentSDK({
        async *query(_params: ClaudeAgentSDKQueryParams) {
          yield {
            type: "result",
            modelUsage,
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      });
      for await (const _message of sdk.query({
        options: { includePartialMessages: partial },
      })) {
        /* drain */
      }
      const root = (await backgroundLogger.drain())
        .filter(isCapturedSpanEvent)
        .find((event) => event.span_attributes?.name === "Claude Agent");
      if (partial) {
        expect(root?.metadata?.total_usage).toEqual(expectedUsage);
      }
      for (const key of [
        "prompt_tokens",
        "completion_tokens",
        "tokens",
        "prompt_cached_tokens",
        "prompt_cache_creation_tokens",
      ]) {
        expect(root?.metrics?.[key]).toBe(
          partial ? undefined : expectedMetrics[key],
        );
      }
    },
  );

  it.each(
    [undefined, 0, 0.125].flatMap((cost) =>
      [false, true].map((partial) => ({ cost, partial })),
    ),
  )(
    "preserves mixed-model usage with reported cost $cost and partial messages $partial",
    async ({ cost, partial }) => {
      const message: ClaudeAgentSDKMessage = {
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
        total_cost_usd: cost,
      };
      const originalMessage = structuredClone(message);
      const sdk = wrapClaudeAgentSDK({
        async *query(_params: ClaudeAgentSDKQueryParams) {
          yield message;
        },
      });
      for await (const received of sdk.query({
        options: {
          model: "claude-sonnet-4-5",
          includePartialMessages: partial,
        },
      })) {
        expect(received).toEqual(originalMessage);
      }
      const root = (await backgroundLogger.drain())
        .filter(isCapturedSpanEvent)
        .find((event) => event.span_attributes?.name === "Claude Agent");
      expect(root?.metadata?.model_usage).toEqual({
        "claude-sonnet-4-5": {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_usd: 0.1,
        },
        "claude-haiku-4-5": {
          input_tokens: 200,
          output_tokens: 70,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_usd: 0.025,
        },
      });
      if (partial) {
        expect(root?.metrics?.tokens).toBeUndefined();
        expect(root?.metrics?.estimated_cost).toBeUndefined();
        expect(root?.metadata?.total_cost_usd).toBe(cost);
        expect(root?.metadata?.total_usage).toEqual({
          input_tokens: 300,
          output_tokens: 120,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        });
      } else {
        expect(root?.metadata?.model).toBeNull();
        expect(root?.metadata?.requested_model).toBe("claude-sonnet-4-5");
        expect(root?.metadata?.total_cost_usd).toBeUndefined();
        expect(root?.metrics?.estimated_cost).toBe(cost);
        expect(root?.metrics?.tokens).toBe(420);
      }
    },
  );

  it.each(
    [0, 20].flatMap((subagentCacheTokens) =>
      [false, true].map((partial) => ({ subagentCacheTokens, partial })),
    ),
  )(
    "preserves cache TTLs with $subagentCacheTokens additional subagent cache-write tokens and partial messages $partial",
    async ({ subagentCacheTokens, partial }) => {
      const message: ClaudeAgentSDKMessage = {
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
            cacheCreationInputTokens: 30 + subagentCacheTokens,
            costUSD: 0.01,
          },
        },
      };
      const originalMessage = structuredClone(message);
      const sdk = wrapClaudeAgentSDK({
        async *query(_params: ClaudeAgentSDKQueryParams) {
          yield message;
        },
      });
      for await (const received of sdk.query({
        options: {
          model: "claude-sonnet-4-5",
          includePartialMessages: partial,
        },
      })) {
        expect(received).toEqual(originalMessage);
      }
      const root = (await backgroundLogger.drain())
        .filter(isCapturedSpanEvent)
        .find((event) => event.span_attributes?.name === "Claude Agent");
      if (partial) {
        expect(root?.metadata?.total_usage).toEqual({
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 30 + subagentCacheTokens,
          cache_creation: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 20,
          },
        });
        expect(root?.metrics?.tokens).toBeUndefined();
      } else {
        expect(root?.metadata?.model).toBe("claude-sonnet-4-5");
        expect(root?.metrics).toMatchObject({
          prompt_tokens: 40 + subagentCacheTokens,
          completion_tokens: 5,
          tokens: 45 + subagentCacheTokens,
          prompt_cache_creation_5m_tokens: 10,
          prompt_cache_creation_1h_tokens: 20,
        });
        expect(root?.metrics?.prompt_cache_creation_tokens).toBe(
          subagentCacheTokens > 0 ? 30 + subagentCacheTokens : undefined,
        );
      }
    },
  );

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
