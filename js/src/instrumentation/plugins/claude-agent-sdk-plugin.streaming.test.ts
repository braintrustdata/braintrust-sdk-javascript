import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  type TestBackgroundLogger,
} from "../../logger";
import { configureNode } from "../../node/config";
import type {
  ClaudeAgentSDKHookCallback,
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryOptions,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";
import { wrapClaudeAgentSDK } from "../../wrappers/claude-agent-sdk/claude-agent-sdk";
import type { BackgroundLogEvent } from "../../../util/index";

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

function spanName(event: CapturedSpanEvent): string | undefined {
  const name = event.span_attributes?.name;
  return typeof name === "string" ? name : undefined;
}

function makeControlledStream<T>(): ControlledStream<T> {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let done = false;

  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        queue.push(value);
      }
    },
    finish() {
      done = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
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
          return Promise.resolve({
            done: true as const,
            value: undefined,
          });
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
                  description: "Metadata check - company",
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

  it("parents local tools to their subagent before and after stream consumption", async () => {
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
      name: "skill_repro",
      tools: [getMetadata],
    });
    const result = sdk.query({
      prompt: "Delegate metadata checking to the metadata-checker subagent.",
      options: {
        model: "claude-scripted",
        mcpServers: { skill_repro: server },
      },
    });
    const iterator = result[Symbol.asyncIterator]();
    const pull = async () => (await iterator.next()).value;
    const runHook = async (
      name: string,
      input: Parameters<ClaudeAgentSDKHookCallback>[0],
      toolUseId: string,
    ) => {
      for (const matcher of injectedOptions?.hooks?.[name] ?? []) {
        for (const hook of matcher.hooks) {
          await hook(input, toolUseId, {
            signal: new AbortController().signal,
          });
        }
      }
    };
    const invokeTool = (toolUseId: string, field: string) =>
      getMetadata.handler(
        { field },
        { _meta: { "claudecode/toolUseId": toolUseId } },
      );

    const taskToolUseId = "toolu_task_1";
    const subagentStartHookId = "subagent-start-hook-request-id";
    const beforeConsumptionToolUseId = "toolu_mcp_before_consumption";
    const afterConsumptionToolUseId = "toolu_mcp_after_consumption";
    const agentId = "agent-metadata-checker";

    await runHook(
      "PreToolUse",
      {
        hook_event_name: "PreToolUse",
        cwd: "/test",
        session_id: "scripted-session",
        tool_input: {
          subagent_type: "metadata-checker",
          description: "Metadata check - company",
          prompt: "Check the metadata fields.",
        },
        tool_name: "Task",
        transcript_path: "/test/transcript.jsonl",
      },
      taskToolUseId,
    );
    await runHook(
      "SubagentStart",
      {
        hook_event_name: "SubagentStart",
        agent_id: agentId,
        agent_type: "metadata-checker",
        cwd: "/test",
        session_id: "scripted-session",
        transcript_path: "/test/transcript.jsonl",
      },
      subagentStartHookId,
    );
    await runHook(
      "PreToolUse",
      {
        hook_event_name: "PreToolUse",
        agent_id: agentId,
        cwd: "/test",
        session_id: "scripted-session",
        tool_input: { field: "country" },
        tool_name: "mcp__skill_repro__get_metadata",
        transcript_path: "/test/transcript.jsonl",
      },
      beforeConsumptionToolUseId,
    );
    await invokeTool(beforeConsumptionToolUseId, "country");
    controlled.push(
      assistantToolUseMessage({
        messageId: "msg_orchestrator",
        parentToolUseId: null,
        toolName: "Task",
        toolUseId: taskToolUseId,
      }),
    );
    await pull();
    controlled.push(
      assistantToolUseMessage({
        messageId: "msg_subagent_before",
        parentToolUseId: taskToolUseId,
        toolName: "mcp__skill_repro__get_metadata",
        toolUseId: beforeConsumptionToolUseId,
      }),
    );
    await pull();

    controlled.push(
      assistantToolUseMessage({
        messageId: "msg_subagent_after",
        parentToolUseId: taskToolUseId,
        toolName: "mcp__skill_repro__get_metadata",
        toolUseId: afterConsumptionToolUseId,
      }),
    );
    await pull();
    await runHook(
      "PreToolUse",
      {
        hook_event_name: "PreToolUse",
        agent_id: agentId,
        cwd: "/test",
        session_id: "scripted-session",
        tool_input: { field: "industry" },
        tool_name: "mcp__skill_repro__get_metadata",
        transcript_path: "/test/transcript.jsonl",
      },
      afterConsumptionToolUseId,
    );
    await invokeTool(afterConsumptionToolUseId, "industry");

    controlled.push({
      type: "result",
      num_turns: 3,
      session_id: "scripted-session",
      usage: { input_tokens: 30, output_tokens: 15 },
    });
    await pull();
    controlled.finish();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });

    const events = (await backgroundLogger.drain()).filter(isCapturedSpanEvent);
    const rootSpan = events.find((event) => spanName(event) === "Claude Agent");
    const subagentSpans = events.filter((event) =>
      spanName(event)?.startsWith("Agent: "),
    );
    const subagentSpan = subagentSpans[0];
    const toolSpans = events.filter(
      (event) => spanName(event) === "tool: skill_repro/get_metadata",
    );
    const toolSpanByUseId = new Map(
      toolSpans.map((span) => [span.metadata?.["gen_ai.tool.call.id"], span]),
    );

    expect(rootSpan).toBeDefined();
    expect(subagentSpans).toHaveLength(1);
    expect(subagentSpan?.metadata?.["claude_agent_sdk.tool_use_id"]).toBe(
      taskToolUseId,
    );
    expect(toolSpans).toHaveLength(2);
    expect(
      toolSpanByUseId.get(afterConsumptionToolUseId)?.span_parents,
    ).toEqual([subagentSpan?.span_id]);
    expect(
      toolSpanByUseId.get(beforeConsumptionToolUseId)?.span_parents,
    ).toEqual([subagentSpan?.span_id]);
  });
});
