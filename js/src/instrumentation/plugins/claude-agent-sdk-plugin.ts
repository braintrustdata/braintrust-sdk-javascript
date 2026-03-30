import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import type { IsoChannelHandlers } from "../../isomorph";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import {
  extractAnthropicCacheTokens,
  finalizeAnthropicTokens,
} from "../../wrappers/anthropic-tokens-util";
import { claudeAgentSDKChannels } from "./claude-agent-sdk-channels";
import type {
  ClaudeAgentSDKHookCallback,
  ClaudeAgentSDKHookCallbackMatcher,
  ClaudeAgentSDKMcpServersConfig,
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryOptions,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";

type ClaudeConversationMessage = { content: unknown; role: string };
type ParsedToolName = {
  displayName: string;
  mcpServer?: string;
  rawToolName: string;
  toolName: string;
};
type ParentSpanResolver = (toolUseID: string) => Promise<string>;

function isSubAgentToolName(toolName: string): boolean {
  return toolName === "Agent" || toolName === "Task";
}

function filterSerializableOptions(
  options: ClaudeAgentSDKQueryOptions,
): Record<string, unknown> {
  const allowedKeys = [
    "model",
    "maxTurns",
    "cwd",
    "continue",
    "allowedTools",
    "disallowedTools",
    "additionalDirectories",
    "permissionMode",
    "debug",
    "apiKey",
    "apiKeySource",
    "agentName",
    "instructions",
  ];

  const filtered: Record<string, unknown> = {};

  for (const key of allowedKeys) {
    if (options[key] !== undefined) {
      filtered[key] = options[key];
    }
  }

  return filtered;
}

function getNumberProperty(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== "object" || !(key in obj)) {
    return undefined;
  }
  const value = Reflect.get(obj, key);
  return typeof value === "number" ? value : undefined;
}

function extractUsageFromMessage(
  message: ClaudeAgentSDKMessage,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  let usage: unknown;
  if (message.type === "assistant") {
    usage = message.message?.usage;
  } else if (message.type === "result") {
    usage = message.usage;
  }

  if (!usage || typeof usage !== "object") {
    return metrics;
  }

  const inputTokens = getNumberProperty(usage, "input_tokens");
  if (inputTokens !== undefined) {
    metrics.prompt_tokens = inputTokens;
  }

  const outputTokens = getNumberProperty(usage, "output_tokens");
  if (outputTokens !== undefined) {
    metrics.completion_tokens = outputTokens;
  }

  const cacheReadTokens =
    getNumberProperty(usage, "cache_read_input_tokens") || 0;
  const cacheCreationTokens =
    getNumberProperty(usage, "cache_creation_input_tokens") || 0;

  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    Object.assign(
      metrics,
      extractAnthropicCacheTokens(cacheReadTokens, cacheCreationTokens),
    );
  }

  if (Object.keys(metrics).length > 0) {
    Object.assign(metrics, finalizeAnthropicTokens(metrics));
  }

  return metrics;
}

function buildLLMInput(
  prompt: string | AsyncIterable<ClaudeAgentSDKMessage> | undefined,
  conversationHistory: ClaudeConversationMessage[],
  capturedPromptMessages?: ClaudeAgentSDKMessage[],
): ClaudeConversationMessage[] | undefined {
  const promptMessages: ClaudeConversationMessage[] = [];

  if (typeof prompt === "string") {
    promptMessages.push({ content: prompt, role: "user" });
  } else if (capturedPromptMessages && capturedPromptMessages.length > 0) {
    for (const msg of capturedPromptMessages) {
      const role = msg.message?.role;
      const content = msg.message?.content;
      if (role && content !== undefined) {
        promptMessages.push({ content, role });
      }
    }
  }

  const inputParts = [...promptMessages, ...conversationHistory];
  return inputParts.length > 0 ? inputParts : undefined;
}

function formatCapturedMessages(
  messages: ClaudeAgentSDKMessage[],
): ClaudeAgentSDKMessage[] {
  return messages.length > 0 ? messages : [];
}

async function createLLMSpanForMessages(
  messages: ClaudeAgentSDKMessage[],
  prompt: string | AsyncIterable<ClaudeAgentSDKMessage> | undefined,
  conversationHistory: ClaudeConversationMessage[],
  options: ClaudeAgentSDKQueryOptions,
  startTime: number,
  capturedPromptMessages: ClaudeAgentSDKMessage[] | undefined,
  parentSpan: string,
): Promise<ClaudeConversationMessage | undefined> {
  if (messages.length === 0) {
    return undefined;
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.type !== "assistant" || !lastMessage.message?.usage) {
    return undefined;
  }

  const model = lastMessage.message.model || options.model;
  const usage = extractUsageFromMessage(lastMessage);
  const input = buildLLMInput(
    prompt,
    conversationHistory,
    capturedPromptMessages,
  );
  const outputs = messages
    .map((m) =>
      m.message?.content && m.message?.role
        ? { content: m.message.content, role: m.message.role }
        : undefined,
    )
    .filter(
      (c): c is { content: NonNullable<unknown>; role: string } =>
        c !== undefined,
    );

  const span = startSpan({
    name: "anthropic.messages.create",
    parent: parentSpan,
    spanAttributes: {
      type: SpanTypeAttribute.LLM,
    },
    startTime,
  });

  span.log({
    input,
    metadata: model ? { model } : undefined,
    metrics: usage,
    output: outputs,
  });

  await span.end();

  return lastMessage.message?.content && lastMessage.message?.role
    ? { content: lastMessage.message.content, role: lastMessage.message.role }
    : undefined;
}

function getMcpServerMetadata(
  serverName: string | undefined,
  mcpServers: ClaudeAgentSDKMcpServersConfig | undefined,
): Record<string, unknown> {
  if (!serverName || !mcpServers) {
    return {};
  }

  const serverConfig = mcpServers[serverName];
  if (!serverConfig) {
    return {};
  }

  const metadata: Record<string, unknown> = {};

  if (serverConfig.type) {
    metadata["mcp.type"] = serverConfig.type;
  } else if (typeof serverConfig === "object" && "transport" in serverConfig) {
    metadata["mcp.type"] = "sdk";
  }

  if (serverConfig.url) {
    metadata["mcp.url"] = serverConfig.url;
  }

  if (serverConfig.command) {
    metadata["mcp.command"] = serverConfig.command;
    if (serverConfig.args) {
      metadata["mcp.args"] = serverConfig.args.join(" ");
    }
  }

  return metadata;
}

function parseToolName(rawToolName: string): ParsedToolName {
  const mcpMatch = rawToolName.match(/^mcp__([^_]+)__(.+)$/);

  if (mcpMatch) {
    const [, mcpServer, toolName] = mcpMatch;
    return {
      displayName: `tool: ${mcpServer}/${toolName}`,
      mcpServer,
      rawToolName,
      toolName,
    };
  }

  return {
    displayName: `tool: ${rawToolName}`,
    rawToolName,
    toolName: rawToolName,
  };
}

function createToolTracingHooks(
  resolveParentSpan: ParentSpanResolver,
  activeToolSpans: Map<string, Span>,
  mcpServers: ClaudeAgentSDKMcpServersConfig | undefined,
  subAgentSpans: Map<string, Span>,
  endedSubAgentSpans: Set<string>,
): {
  postToolUse: ClaudeAgentSDKHookCallback;
  postToolUseFailure: ClaudeAgentSDKHookCallback;
  preToolUse: ClaudeAgentSDKHookCallback;
} {
  const preToolUse: ClaudeAgentSDKHookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse" || !toolUseID) {
      return {};
    }

    if (isSubAgentToolName(input.tool_name)) {
      return {};
    }

    const parsed = parseToolName(input.tool_name);
    const toolSpan = startSpan({
      event: {
        input: input.tool_input,
        metadata: {
          "claude_agent_sdk.cwd": input.cwd,
          "claude_agent_sdk.raw_tool_name": parsed.rawToolName,
          "claude_agent_sdk.session_id": input.session_id,
          "gen_ai.tool.call.id": toolUseID,
          "gen_ai.tool.name": parsed.toolName,
          ...(parsed.mcpServer && { "mcp.server": parsed.mcpServer }),
          ...getMcpServerMetadata(parsed.mcpServer, mcpServers),
        },
      },
      name: parsed.displayName,
      parent: await resolveParentSpan(toolUseID),
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    });

    activeToolSpans.set(toolUseID, toolSpan);
    return {};
  };

  const postToolUse: ClaudeAgentSDKHookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "PostToolUse" || !toolUseID) {
      return {};
    }

    const subAgentSpan = subAgentSpans.get(toolUseID);
    if (subAgentSpan) {
      try {
        const response = input.tool_response as
          | Record<string, unknown>
          | undefined;
        const metadata: Record<string, unknown> = {};
        if (response?.status) {
          metadata["claude_agent_sdk.status"] = response.status;
        }
        if (response?.totalDurationMs) {
          metadata["claude_agent_sdk.duration_ms"] = response.totalDurationMs;
        }
        if (response?.totalToolUseCount !== undefined) {
          metadata["claude_agent_sdk.tool_use_count"] =
            response.totalToolUseCount;
        }

        subAgentSpan.log({
          metadata,
          output: response?.content,
        });
      } finally {
        subAgentSpan.end();
        endedSubAgentSpans.add(toolUseID);
      }

      return {};
    }

    const toolSpan = activeToolSpans.get(toolUseID);
    if (!toolSpan) {
      return {};
    }

    try {
      toolSpan.log({ output: input.tool_response });
    } finally {
      toolSpan.end();
      activeToolSpans.delete(toolUseID);
    }

    return {};
  };

  const postToolUseFailure: ClaudeAgentSDKHookCallback = async (
    input,
    toolUseID,
  ) => {
    if (input.hook_event_name !== "PostToolUseFailure" || !toolUseID) {
      return {};
    }

    const subAgentSpan = subAgentSpans.get(toolUseID);
    if (subAgentSpan) {
      try {
        subAgentSpan.log({ error: input.error });
      } finally {
        subAgentSpan.end();
        endedSubAgentSpans.add(toolUseID);
      }

      return {};
    }

    const toolSpan = activeToolSpans.get(toolUseID);
    if (!toolSpan) {
      return {};
    }

    const parsed = parseToolName(input.tool_name);
    try {
      toolSpan.log({
        error: input.error,
        metadata: {
          "claude_agent_sdk.is_interrupt": input.is_interrupt,
          "claude_agent_sdk.session_id": input.session_id,
          "gen_ai.tool.call.id": toolUseID,
          "gen_ai.tool.name": parsed.toolName,
          ...(parsed.mcpServer && { "mcp.server": parsed.mcpServer }),
        },
      });
    } finally {
      toolSpan.end();
      activeToolSpans.delete(toolUseID);
    }

    return {};
  };

  return { postToolUse, postToolUseFailure, preToolUse };
}

function injectTracingHooks(
  options: ClaudeAgentSDKQueryOptions,
  resolveParentSpan: ParentSpanResolver,
  activeToolSpans: Map<string, Span>,
  subAgentSpans: Map<string, Span>,
  endedSubAgentSpans: Set<string>,
): ClaudeAgentSDKQueryOptions {
  const { preToolUse, postToolUse, postToolUseFailure } =
    createToolTracingHooks(
      resolveParentSpan,
      activeToolSpans,
      options.mcpServers,
      subAgentSpans,
      endedSubAgentSpans,
    );

  const existingHooks = options.hooks ?? {};

  return {
    ...options,
    hooks: {
      ...existingHooks,
      PostToolUse: [
        ...(existingHooks.PostToolUse ?? []),
        { hooks: [postToolUse] } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
      PostToolUseFailure: [
        ...(existingHooks.PostToolUseFailure ?? []),
        {
          hooks: [postToolUseFailure],
        } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
      PreToolUse: [
        ...(existingHooks.PreToolUse ?? []),
        { hooks: [preToolUse] } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
    },
  };
}

type QueryState = {
  accumulatedOutputTokens: number;
  activeToolSpans: Map<string, Span>;
  capturedPromptMessages: ClaudeAgentSDKMessage[] | undefined;
  currentMessageId: string | undefined;
  currentMessageStartTime: number;
  currentMessages: ClaudeAgentSDKMessage[];
  endedSubAgentSpans: Set<string>;
  finalResults: ClaudeConversationMessage[];
  options: ClaudeAgentSDKQueryOptions;
  originalPrompt: string | AsyncIterable<ClaudeAgentSDKMessage> | undefined;
  pendingSubAgentNames: Map<string, string>;
  processing: Promise<void>;
  promptDone: Promise<void>;
  promptStarted: () => boolean;
  span: Span;
  subAgentSpans: Map<string, Span>;
  toolUseToParent: Map<string, string | null>;
};

async function finalizeCurrentMessageGroup(state: QueryState): Promise<void> {
  if (state.currentMessages.length === 0) {
    return;
  }

  const parentToolUseId = state.currentMessages[0]?.parent_tool_use_id ?? null;
  let parentSpan = await state.span.export();
  if (parentToolUseId) {
    const subAgentSpan = state.subAgentSpans.get(parentToolUseId);
    if (subAgentSpan) {
      parentSpan = await subAgentSpan.export();
    }
  }

  const finalMessage = await createLLMSpanForMessages(
    state.currentMessages,
    state.originalPrompt,
    state.finalResults,
    state.options,
    state.currentMessageStartTime,
    state.capturedPromptMessages,
    parentSpan,
  );

  if (finalMessage) {
    state.finalResults.push(finalMessage);
  }

  const lastMessage = state.currentMessages[state.currentMessages.length - 1];
  if (lastMessage?.message?.usage) {
    state.accumulatedOutputTokens +=
      getNumberProperty(lastMessage.message.usage, "output_tokens") || 0;
  }

  state.currentMessages.length = 0;
}

function maybeTrackToolUseContext(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): void {
  if (
    message.type !== "assistant" ||
    !Array.isArray(message.message?.content)
  ) {
    return;
  }

  const parentToolUseId = message.parent_tool_use_id ?? null;

  for (const block of message.message.content) {
    if (
      typeof block !== "object" ||
      block === null ||
      !("type" in block) ||
      block.type !== "tool_use" ||
      !("id" in block) ||
      typeof block.id !== "string"
    ) {
      continue;
    }

    state.toolUseToParent.set(block.id, parentToolUseId);

    if (
      block.name === "Task" &&
      typeof block.input === "object" &&
      block.input !== null &&
      "subagent_type" in block.input &&
      typeof block.input.subagent_type === "string"
    ) {
      state.pendingSubAgentNames.set(block.id, block.input.subagent_type);
    }
  }
}

async function maybeStartSubAgentSpan(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): Promise<void> {
  if (!("parent_tool_use_id" in message)) {
    return;
  }

  const parentToolUseId = message.parent_tool_use_id;
  if (!parentToolUseId) {
    return;
  }

  await ensureSubAgentSpan(
    state.pendingSubAgentNames,
    state.span,
    state.subAgentSpans,
    parentToolUseId,
  );
}

async function ensureSubAgentSpan(
  pendingSubAgentNames: Map<string, string>,
  rootSpan: Span,
  subAgentSpans: Map<string, Span>,
  parentToolUseId: string,
): Promise<Span> {
  const existingSpan = subAgentSpans.get(parentToolUseId);
  if (existingSpan) {
    return existingSpan;
  }

  const agentName = pendingSubAgentNames.get(parentToolUseId);
  const spanName = agentName ? `Agent: ${agentName}` : "Agent: sub-agent";

  const subAgentSpan = startSpan({
    event: {
      metadata: {
        ...(agentName && { "claude_agent_sdk.agent_type": agentName }),
      },
    },
    name: spanName,
    parent: await rootSpan.export(),
    spanAttributes: { type: SpanTypeAttribute.TASK },
  });

  subAgentSpans.set(parentToolUseId, subAgentSpan);
  return subAgentSpan;
}

async function handleStreamMessage(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): Promise<void> {
  maybeTrackToolUseContext(state, message);
  await maybeStartSubAgentSpan(state, message);

  const messageId = message.message?.id;
  if (messageId && messageId !== state.currentMessageId) {
    await finalizeCurrentMessageGroup(state);
    state.currentMessageId = messageId;
    state.currentMessageStartTime = getCurrentUnixTimestamp();
  }

  if (message.type === "assistant" && message.message?.usage) {
    state.currentMessages.push(message);
  }

  if (message.type !== "result" || !message.usage) {
    return;
  }

  const finalUsageMetrics = extractUsageFromMessage(message);
  if (
    state.currentMessages.length > 0 &&
    finalUsageMetrics.completion_tokens !== undefined
  ) {
    const lastMessage = state.currentMessages[state.currentMessages.length - 1];
    if (lastMessage?.message?.usage) {
      const adjustedTokens =
        finalUsageMetrics.completion_tokens - state.accumulatedOutputTokens;
      if (adjustedTokens >= 0) {
        lastMessage.message.usage.output_tokens = adjustedTokens;
      }

      const resultUsage = message.usage;
      if (resultUsage && typeof resultUsage === "object") {
        const cacheReadTokens = getNumberProperty(
          resultUsage,
          "cache_read_input_tokens",
        );
        if (cacheReadTokens !== undefined) {
          lastMessage.message.usage.cache_read_input_tokens = cacheReadTokens;
        }

        const cacheCreationTokens = getNumberProperty(
          resultUsage,
          "cache_creation_input_tokens",
        );
        if (cacheCreationTokens !== undefined) {
          lastMessage.message.usage.cache_creation_input_tokens =
            cacheCreationTokens;
        }
      }
    }
  }

  const metadata: Record<string, unknown> = {};
  if (message.num_turns !== undefined) {
    metadata.num_turns = message.num_turns;
  }
  if (message.session_id !== undefined) {
    metadata.session_id = message.session_id;
  }
  if (Object.keys(metadata).length > 0) {
    state.span.log({ metadata });
  }
}

async function finalizeQuerySpan(state: QueryState): Promise<void> {
  try {
    await finalizeCurrentMessageGroup(state);

    state.span.log({
      output:
        state.finalResults.length > 0
          ? state.finalResults[state.finalResults.length - 1]
          : undefined,
    });

    if (state.capturedPromptMessages) {
      if (state.promptStarted()) {
        await state.promptDone;
      }
      if (state.capturedPromptMessages.length > 0) {
        state.span.log({
          input: formatCapturedMessages(state.capturedPromptMessages),
        });
      }
    }
  } finally {
    for (const [id, subAgentSpan] of state.subAgentSpans) {
      if (!state.endedSubAgentSpans.has(id)) {
        subAgentSpan.end();
      }
    }
    state.subAgentSpans.clear();
    state.span.end();
  }
}

export class ClaudeAgentSDKPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToQuery();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToQuery(): void {
    const channel = claudeAgentSDKChannels.query.tracingChannel();
    const spans = new WeakMap<object, QueryState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof claudeAgentSDKChannels.query>
    > = {
      start: (event) => {
        const params = (event.arguments[0] ?? {}) as ClaudeAgentSDKQueryParams;
        const originalPrompt = params.prompt;
        const options = params.options ?? {};
        const promptIsAsyncIterable = isAsyncIterable(originalPrompt);
        let promptStarted = false;
        let capturedPromptMessages: ClaudeAgentSDKMessage[] | undefined;
        let resolvePromptDone: (() => void) | undefined;
        const promptDone = new Promise<void>((resolve) => {
          resolvePromptDone = resolve;
        });

        if (promptIsAsyncIterable) {
          capturedPromptMessages = [];
          const promptStream =
            originalPrompt as AsyncIterable<ClaudeAgentSDKMessage>;
          params.prompt = (async function* () {
            promptStarted = true;
            try {
              for await (const message of promptStream) {
                capturedPromptMessages!.push(message);
                yield message;
              }
            } finally {
              resolvePromptDone?.();
            }
          })();
        }

        const span = startSpan({
          name: "Claude Agent",
          spanAttributes: {
            type: SpanTypeAttribute.TASK,
          },
        });
        const startTime = getCurrentUnixTimestamp();

        try {
          span.log({
            input:
              typeof originalPrompt === "string"
                ? originalPrompt
                : promptIsAsyncIterable
                  ? undefined
                  : originalPrompt !== undefined
                    ? String(originalPrompt)
                    : undefined,
            metadata: filterSerializableOptions(options),
          });
        } catch (error) {
          console.error("Error extracting input for Claude Agent SDK:", error);
        }

        const activeToolSpans = new Map<string, Span>();
        const subAgentSpans = new Map<string, Span>();
        const endedSubAgentSpans = new Set<string>();
        const toolUseToParent = new Map<string, string | null>();
        const pendingSubAgentNames = new Map<string, string>();
        const optionsWithHooks = injectTracingHooks(
          options,
          async (toolUseID) => {
            const parentToolUseId = toolUseToParent.get(toolUseID);
            if (parentToolUseId) {
              const subAgentSpan = await ensureSubAgentSpan(
                pendingSubAgentNames,
                span,
                subAgentSpans,
                parentToolUseId,
              );
              return subAgentSpan.export();
            }
            return span.export();
          },
          activeToolSpans,
          subAgentSpans,
          endedSubAgentSpans,
        );

        params.options = optionsWithHooks;
        event.arguments[0] = params;

        spans.set(event, {
          accumulatedOutputTokens: 0,
          activeToolSpans,
          capturedPromptMessages,
          currentMessageId: undefined,
          currentMessageStartTime: startTime,
          currentMessages: [],
          endedSubAgentSpans,
          finalResults: [],
          options: optionsWithHooks,
          originalPrompt,
          pendingSubAgentNames,
          processing: Promise.resolve(),
          promptDone,
          promptStarted: () => promptStarted,
          span,
          subAgentSpans,
          toolUseToParent,
        });
      },

      end: (event) => {
        const state = spans.get(event);
        if (!state) {
          return;
        }

        const eventResult = event.result;
        if (eventResult === undefined) {
          state.span.end();
          spans.delete(event);
          return;
        }

        if (isAsyncIterable(eventResult)) {
          patchStreamIfNeeded(eventResult, {
            onChunk: (message: ClaudeAgentSDKMessage) => {
              maybeTrackToolUseContext(state, message);
              state.processing = state.processing
                .then(() => handleStreamMessage(state, message))
                .catch((error) => {
                  console.error(
                    "Error processing Claude Agent SDK stream chunk:",
                    error,
                  );
                });
            },
            onComplete: () =>
              state.processing
                .then(() => finalizeQuerySpan(state))
                .finally(() => {
                  spans.delete(event);
                }),
            onError: (error: Error) =>
              state.processing
                .then(() => {
                  state.span.log({
                    error: error.message,
                  });
                })
                .then(() => finalizeQuerySpan(state))
                .finally(() => {
                  spans.delete(event);
                }),
          });

          return;
        }

        try {
          state.span.log({ output: eventResult });
        } catch (error) {
          console.error("Error extracting output for Claude Agent SDK:", error);
        } finally {
          state.span.end();
          spans.delete(event);
        }
      },

      error: (event) => {
        const state = spans.get(event);
        if (!state || !event.error) {
          return;
        }

        state.span.log({
          error: event.error.message,
        });
        state.span.end();
        spans.delete(event);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }
}
