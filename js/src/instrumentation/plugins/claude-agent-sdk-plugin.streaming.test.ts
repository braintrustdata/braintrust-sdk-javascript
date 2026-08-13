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
