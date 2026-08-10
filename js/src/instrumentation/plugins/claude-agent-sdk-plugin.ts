import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import iso, { type IsoChannelHandlers } from "../../isomorph";
import { debugLogger } from "../../debug-logger";
import { startSpan as startBaseSpan } from "../../logger";
import type { Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import {
  extractAnthropicCacheTokens,
  finalizeAnthropicTokens,
  toNumericMetrics,
  type AnthropicTokenMetrics,
} from "../../wrappers/anthropic-tokens-util";
import { claudeAgentSDKChannels } from "./claude-agent-sdk-channels";
import { CLAUDE_AGENT_SDK_SKIP_LOCAL_TOOL_HOOKS_OPTION } from "./claude-agent-sdk-instrumentation-constants";
import {
  collectLocalMcpServerToolHookNames,
  wrapLocalMcpServerToolHandlers,
} from "./claude-agent-sdk-local-tool-spans";
import {
  bindClaudeLocalToolContextToAsyncIterable,
  createClaudeLocalToolContext,
  setClaudeLocalToolParentResolver,
  type ClaudeAgentSDKLocalToolContext,
} from "./claude-agent-sdk-local-tool-context";
import type {
  ClaudeAgentSDKHookCallback,
  ClaudeAgentSDKHookCallbackMatcher,
  ClaudeAgentSDKMcpServersConfig,
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryOptions,
  ClaudeAgentSDKQueryParams,
  ClaudeAgentSDKUsage,
} from "../../vendor-sdk-types/claude-agent-sdk";

type ClaudeConversationMessage = { content: unknown; role: string };
type ParsedToolName = {
  displayName: string;
  mcpServer?: string;
  rawToolName: string;
  toolName: string;
};
type ParentSpanResolver = (
  toolUseID: string,
  context?: { agentId?: string },
) => Promise<string>;
type LLMSpanResult = {
  finalMessage: ClaudeConversationMessage | undefined;
  span: Span;
  spanExport: string;
};
type PendingLLMUsage = {
  messageId: string;
  span: Span;
  usage: ClaudeAgentSDKUsage;
};
type TranscriptUsageState = {
  pendingLlmUsageByContextKey: Map<string, PendingLLMUsage>;
  rootTranscriptPath?: string;
  subagentTranscriptPathByToolUseId: Map<string, string>;
};
type SubAgentDetails = {
  agentId?: string;
  agentType?: string;
  description?: string;
  taskId?: string;
  taskType?: string;
  toolUseId?: string;
  workflowName?: string;
};
const ROOT_LLM_PARENT_KEY = "__root__";
const SUB_AGENT_PROMPT_SOURCE_PRIORITY = {
  delegation: 0,
  lifecycle: 1,
  sidechain: 2,
} as const;
type SubAgentPromptSource = keyof typeof SUB_AGENT_PROMPT_SOURCE_PRIORITY;

function llmParentKey(parentToolUseId: string | null): string {
  return parentToolUseId ?? ROOT_LLM_PARENT_KEY;
}

function llmUsageContextKey(
  parentToolUseId: string | null,
  messageId: string,
): string {
  return JSON.stringify([llmParentKey(parentToolUseId), messageId]);
}

function isSubAgentDelegationToolName(toolName: string): boolean {
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

function getStringProperty(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object" || !(key in obj)) {
    return undefined;
  }
  const value = Reflect.get(obj, key);
  return typeof value === "string" ? value : undefined;
}

function upsertSubAgentDetails(
  detailsByToolUseId: Map<string, SubAgentDetails>,
  toolUseId: string,
  update: SubAgentDetails,
): SubAgentDetails {
  const existing = detailsByToolUseId.get(toolUseId) ?? {};
  const merged = {
    ...existing,
    ...Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined),
    ),
  } satisfies SubAgentDetails;
  detailsByToolUseId.set(toolUseId, merged);
  return merged;
}

function formatSubAgentSpanName(details: SubAgentDetails | undefined): string {
  if (details?.description) {
    return `Agent: ${details.description}`;
  }

  if (details?.agentType) {
    return `Agent: ${details.agentType}`;
  }

  return "Agent: sub-agent";
}

function subAgentDetailsToMetadata(
  details: SubAgentDetails | undefined,
): Record<string, unknown> {
  if (!details) {
    return {};
  }

  const metadata: Record<string, unknown> = {};

  if (details.agentId) {
    metadata["claude_agent_sdk.agent_id"] = details.agentId;
  }
  if (details.agentType) {
    metadata["claude_agent_sdk.agent_type"] = details.agentType;
  }
  if (details.description) {
    metadata["claude_agent_sdk.description"] = details.description;
  }
  if (details.taskId) {
    metadata["claude_agent_sdk.task_id"] = details.taskId;
  }
  if (details.taskType) {
    metadata["claude_agent_sdk.task_type"] = details.taskType;
  }
  if (details.toolUseId) {
    metadata["claude_agent_sdk.tool_use_id"] = details.toolUseId;
  }
  if (details.workflowName) {
    metadata["claude_agent_sdk.workflow_name"] = details.workflowName;
  }

  return metadata;
}

function resolveTaskToolUseId(
  taskIdToToolUseId: Map<string, string>,
  message: ClaudeAgentSDKMessage,
): string | undefined {
  const messageToolUseId =
    typeof message.tool_use_id === "string" ? message.tool_use_id : undefined;
  if (messageToolUseId && typeof message.task_id === "string") {
    taskIdToToolUseId.set(message.task_id, messageToolUseId);
  }
  if (messageToolUseId) {
    return messageToolUseId;
  }
  if (typeof message.task_id === "string") {
    return taskIdToToolUseId.get(message.task_id);
  }
  return undefined;
}

function seedTaskToolUseIdMapping(
  taskIdToToolUseId: Map<string, string>,
  message: ClaudeAgentSDKMessage,
): void {
  if (
    typeof message.task_id === "string" &&
    typeof message.tool_use_id === "string"
  ) {
    taskIdToToolUseId.set(message.task_id, message.tool_use_id);
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

/**
 * Snapshots the token fields we understand out of a provider usage object.
 *
 * Fields degrade individually: Bedrock, Vertex, and gateway-backed runs report
 * `null` for cache fields they do not populate, and one unusable field must
 * only cost that metric rather than the whole usage object.
 */
function copyUsage(
  usage: unknown,
  requireInputAndOutput = false,
): ClaudeAgentSDKUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const copy: ClaudeAgentSDKUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ] as const) {
    const value = tokenCount(Reflect.get(usage, key));
    if (value !== undefined) {
      copy[key] = value;
    }
  }

  const cacheCreation = Reflect.get(usage, "cache_creation");
  if (cacheCreation && typeof cacheCreation === "object") {
    const cacheCreationCopy: NonNullable<
      ClaudeAgentSDKUsage["cache_creation"]
    > = {};
    for (const key of [
      "ephemeral_5m_input_tokens",
      "ephemeral_1h_input_tokens",
    ] as const) {
      const value = tokenCount(Reflect.get(cacheCreation, key));
      if (value !== undefined) {
        cacheCreationCopy[key] = value;
      }
    }
    if (Object.keys(cacheCreationCopy).length > 0) {
      copy.cache_creation = cacheCreationCopy;
    }
  }

  if (
    requireInputAndOutput &&
    (copy.input_tokens === undefined || copy.output_tokens === undefined)
  ) {
    return undefined;
  }

  return Object.keys(copy).length > 0 ? copy : undefined;
}

/** Layers a newer usage snapshot over an older one, field by field. */
function mergeUsage(
  base: ClaudeAgentSDKUsage | undefined,
  override: ClaudeAgentSDKUsage | undefined,
): ClaudeAgentSDKUsage | undefined {
  if (!base || !override) {
    return override ?? base;
  }

  const cacheCreation =
    base.cache_creation || override.cache_creation
      ? { ...base.cache_creation, ...override.cache_creation }
      : undefined;
  return {
    ...base,
    ...override,
    ...(cacheCreation && { cache_creation: cacheCreation }),
  };
}

function parseTranscriptRowUsage(
  line: string,
  messageId: string,
): ClaudeAgentSDKUsage | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!row || typeof row !== "object") {
    return undefined;
  }
  if (getStringProperty(row, "type") !== "assistant") {
    return undefined;
  }

  const message = Reflect.get(row, "message");
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if (getStringProperty(message, "id") !== messageId) {
    return undefined;
  }

  return copyUsage(Reflect.get(message, "usage"), true);
}

function parseTranscriptUsage(
  bytes: Uint8Array,
  messageIds: Set<string>,
): Map<string, ClaudeAgentSDKUsage> {
  const finalUsageByMessageId = new Map<string, ClaudeAgentSDKUsage>();
  if (messageIds.size === 0) {
    return finalUsageByMessageId;
  }

  const text = new TextDecoder().decode(bytes);
  for (const messageId of messageIds) {
    // Transcripts for `continue`/`resume` sessions routinely reach tens of
    // megabytes, so seek the rows we actually need instead of parsing every
    // row in the session on each query completion.
    let searchTo = text.length;
    while (searchTo >= 0) {
      const match = text.lastIndexOf(messageId, searchTo);
      if (match < 0) {
        break;
      }

      const lineStart = text.lastIndexOf("\n", match) + 1;
      const lineEnd = text.indexOf("\n", match);
      // Transcript rows for one provider request are successive snapshots, not
      // separate model calls. The last valid row contains the final usage.
      const usage = parseTranscriptRowUsage(
        text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd),
        messageId,
      );
      if (usage) {
        finalUsageByMessageId.set(messageId, usage);
        break;
      }

      searchTo = lineStart - 1;
    }
  }

  return finalUsageByMessageId;
}

function recoveredUsage(
  pendingUsage: ClaudeAgentSDKUsage,
  transcriptUsage: ClaudeAgentSDKUsage,
): ClaudeAgentSDKUsage | undefined {
  const inputTokens = tokenCount(
    transcriptUsage.input_tokens ?? pendingUsage.input_tokens,
  );
  const outputTokens = tokenCount(transcriptUsage.output_tokens);
  const cacheReadTokens = tokenCount(
    transcriptUsage.cache_read_input_tokens ??
      pendingUsage.cache_read_input_tokens ??
      0,
  );
  const cacheCreationTokens = tokenCount(
    transcriptUsage.cache_creation_input_tokens ??
      pendingUsage.cache_creation_input_tokens ??
      0,
  );

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }

  const cacheCreation =
    transcriptUsage.cache_creation ?? pendingUsage.cache_creation;

  return {
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheCreation && { cache_creation: { ...cacheCreation } }),
  };
}

async function recoverUsageFromTranscript(
  state: TranscriptUsageState,
): Promise<void> {
  const readFile = iso.readFile;
  if (!readFile || state.pendingLlmUsageByContextKey.size === 0) {
    return;
  }

  const pendingMessageIds = new Set<string>();
  for (const pending of state.pendingLlmUsageByContextKey.values()) {
    pendingMessageIds.add(pending.messageId);
  }

  const parentToolUseIdsByTranscriptPath = new Map<
    string,
    Set<string | null>
  >();
  const addTranscriptPath = (
    transcriptPath: string,
    parentToolUseId: string | null,
  ) => {
    const parentToolUseIds =
      parentToolUseIdsByTranscriptPath.get(transcriptPath) ?? new Set();
    parentToolUseIds.add(parentToolUseId);
    parentToolUseIdsByTranscriptPath.set(transcriptPath, parentToolUseIds);
  };

  if (state.rootTranscriptPath) {
    addTranscriptPath(state.rootTranscriptPath, null);
  }
  for (const [
    toolUseId,
    transcriptPath,
  ] of state.subagentTranscriptPathByToolUseId) {
    addTranscriptPath(transcriptPath, toolUseId);
  }

  const transcriptUsages = await Promise.all(
    Array.from(
      parentToolUseIdsByTranscriptPath,
      async ([transcriptPath, parentToolUseIds]) => {
        try {
          return {
            parentToolUseIds,
            usageByMessageId: parseTranscriptUsage(
              await readFile(transcriptPath),
              pendingMessageIds,
            ),
          };
        } catch (error) {
          debugLogger.debug(
            "Could not recover Claude Agent SDK transcript usage",
            error,
          );
          return undefined;
        }
      },
    ),
  );

  for (const transcriptUsage of transcriptUsages) {
    if (!transcriptUsage) {
      continue;
    }

    for (const parentToolUseId of transcriptUsage.parentToolUseIds) {
      for (const [
        messageId,
        usageFromTranscript,
      ] of transcriptUsage.usageByMessageId) {
        const contextKey = llmUsageContextKey(parentToolUseId, messageId);
        const pending = state.pendingLlmUsageByContextKey.get(contextKey);
        if (!pending) {
          continue;
        }

        const usage = recoveredUsage(pending.usage, usageFromTranscript);
        if (!usage) {
          continue;
        }

        try {
          pending.span.log({ metrics: extractUsage(usage, true) });
          state.pendingLlmUsageByContextKey.delete(contextKey);
        } catch (error) {
          debugLogger.debug(
            "Could not update Claude Agent SDK span with transcript usage",
            error,
          );
        }
      }
    }
  }
}

// The CLI appends the final assistant row around the time the query stream
// completes, so give a transcript that is still missing rows a couple of very
// short chances to catch up before giving up on those spans' output tokens.
const TRANSCRIPT_RECOVERY_ATTEMPTS = 3;
const TRANSCRIPT_RECOVERY_RETRY_MS = 25;

async function recoverUsageWithRetries(
  state: TranscriptUsageState,
): Promise<void> {
  for (let attempt = 0; attempt < TRANSCRIPT_RECOVERY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, TRANSCRIPT_RECOVERY_RETRY_MS),
      );
    }

    await recoverUsageFromTranscript(state);
    if (state.pendingLlmUsageByContextKey.size === 0) {
      return;
    }
    if (
      state.rootTranscriptPath === undefined &&
      state.subagentTranscriptPathByToolUseId.size === 0
    ) {
      // No transcript to wait on, so retrying cannot resolve anything.
      return;
    }
  }
}

function extractUsage(
  usage: ClaudeAgentSDKUsage | undefined,
  includeOutput: boolean,
  omitLegacyCacheCreationMetric = false,
): Record<string, number> {
  const metrics: AnthropicTokenMetrics = {};
  if (!usage) {
    return {};
  }

  const inputTokens = getNumberProperty(usage, "input_tokens");
  if (inputTokens !== undefined) {
    metrics.prompt_tokens = inputTokens;
  }

  if (includeOutput) {
    const outputTokens = getNumberProperty(usage, "output_tokens");
    if (outputTokens !== undefined) {
      metrics.completion_tokens = outputTokens;
    }
  }

  const cacheReadTokens =
    getNumberProperty(usage, "cache_read_input_tokens") || 0;
  const cacheCreationTokens =
    getNumberProperty(usage, "cache_creation_input_tokens") || 0;
  Object.assign(
    metrics,
    extractAnthropicCacheTokens(cacheReadTokens, cacheCreationTokens),
  );

  const cacheCreation5mTokens = getNumberProperty(
    usage.cache_creation,
    "ephemeral_5m_input_tokens",
  );
  const cacheCreation1hTokens = getNumberProperty(
    usage.cache_creation,
    "ephemeral_1h_input_tokens",
  );
  if (cacheCreation5mTokens !== undefined) {
    metrics.prompt_cache_creation_5m_tokens = cacheCreation5mTokens;
  }
  if (cacheCreation1hTokens !== undefined) {
    metrics.prompt_cache_creation_1h_tokens = cacheCreation1hTokens;
  }

  if (Object.keys(metrics).length === 0) {
    return {};
  }

  // `finalizeAnthropicTokens` drops the aggregate cache-creation metric when the
  // per-TTL breakdown is present, so the finalized object replaces `metrics`
  // rather than being merged back over it.
  const finalized = finalizeAnthropicTokens(metrics);
  if (metrics.completion_tokens === undefined) {
    // A total is only meaningful once both halves are known.
    delete finalized.tokens;
  }
  if (omitLegacyCacheCreationMetric) {
    // Span metrics can only be added, never removed, so hold the aggregate back
    // until we know a per-TTL breakdown will not arrive from the transcript.
    delete finalized.prompt_cache_creation_tokens;
  }

  return toNumericMetrics(finalized);
}

function buildLLMInput(
  promptMessages: ClaudeConversationMessage[],
  conversationHistory: ClaudeConversationMessage[],
): ClaudeConversationMessage[] | undefined {
  const inputParts = [...promptMessages, ...conversationHistory];
  return inputParts.length > 0 ? inputParts : undefined;
}

function conversationMessageFromSDKMessage(
  message: ClaudeAgentSDKMessage,
): ClaudeConversationMessage | undefined {
  const role = message.message?.role;
  const content = message.message?.content;
  if (role && content !== undefined) {
    return { content, role };
  }

  return undefined;
}

function messageContentHasBlockType(
  message: ClaudeAgentSDKMessage,
  blockType: string,
): boolean {
  const content = message.message?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === blockType,
    )
  );
}

function buildRootPromptMessages(
  prompt: string | AsyncIterable<ClaudeAgentSDKMessage> | undefined,
  capturedPromptMessages?: ClaudeAgentSDKMessage[],
): ClaudeConversationMessage[] {
  if (typeof prompt === "string") {
    return [{ content: prompt, role: "user" }];
  }

  if (!capturedPromptMessages || capturedPromptMessages.length === 0) {
    return [];
  }

  return capturedPromptMessages
    .map(conversationMessageFromSDKMessage)
    .filter(
      (message): message is ClaudeConversationMessage => message !== undefined,
    );
}

function formatCapturedMessages(
  messages: ClaudeAgentSDKMessage[],
): ClaudeAgentSDKMessage[] {
  return messages.length > 0 ? messages : [];
}

async function createLLMSpanForMessages(
  messages: ClaudeAgentSDKMessage[],
  promptMessages: ClaudeConversationMessage[],
  conversationHistory: ClaudeConversationMessage[],
  options: ClaudeAgentSDKQueryOptions,
  startTime: number,
  parentSpan: string,
  usage: ClaudeAgentSDKUsage | undefined,
  hasFinalOutputUsage: boolean,
  existingSpan?: Span,
): Promise<LLMSpanResult | undefined> {
  if (messages.length === 0) {
    return undefined;
  }

  const lastMessage = messages[messages.length - 1];
  // Every assistant message is one provider request and must produce one `llm`
  // span. Unusable usage costs metrics, never the span or its payloads.
  if (lastMessage.type !== "assistant") {
    return undefined;
  }

  const model = lastMessage.message?.model || options.model;
  const metrics = extractUsage(
    usage,
    hasFinalOutputUsage,
    !hasFinalOutputUsage,
  );
  const input = buildLLMInput(promptMessages, conversationHistory);
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

  const span =
    existingSpan ??
    startBaseSpan(
      withSpanInstrumentationName(
        {
          name: "anthropic.messages.create",
          parent: parentSpan,
          spanAttributes: {
            type: SpanTypeAttribute.LLM,
          },
          startTime,
        },
        INSTRUMENTATION_NAMES.CLAUDE_AGENT_SDK,
      ),
    );

  span.log({
    input,
    metadata: { ...(model && { model }), provider: "anthropic" },
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    output: outputs,
  });

  const spanExport = await span.export();
  await span.end();

  const finalMessage =
    lastMessage.message?.content && lastMessage.message?.role
      ? { content: lastMessage.message.content, role: lastMessage.message.role }
      : undefined;

  return {
    finalMessage,
    span,
    spanExport,
  };
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

function isLocalToolUse(
  rawToolName: string,
  mcpServers: ClaudeAgentSDKMcpServersConfig | undefined,
): boolean {
  const parsed = parseToolName(rawToolName);
  if (!parsed.mcpServer || !mcpServers) {
    return false;
  }

  const serverConfig = mcpServers[parsed.mcpServer];
  if (!serverConfig || typeof serverConfig !== "object") {
    return false;
  }

  return serverConfig.type === "sdk" || "transport" in serverConfig;
}

function prepareLocalToolHandlersInMcpServers(
  mcpServers: ClaudeAgentSDKMcpServersConfig | undefined,
): { hasLocalToolHandlers: boolean; localToolHookNames: Set<string> } {
  const localToolHookNames = new Set<string>();
  if (!mcpServers) {
    return {
      hasLocalToolHandlers: false,
      localToolHookNames,
    };
  }

  let hasLocalToolHandlers = false;
  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    const toolNames = collectLocalMcpServerToolHookNames(
      serverName,
      serverConfig,
    );
    for (const toolName of toolNames) {
      localToolHookNames.add(toolName);
    }
    if (toolNames.size > 0) {
      hasLocalToolHandlers = true;
    }

    if (wrapLocalMcpServerToolHandlers(serverName, serverConfig)) {
      hasLocalToolHandlers = true;
    }
  }

  return { hasLocalToolHandlers, localToolHookNames };
}

function createToolTracingHooks(
  resolveParentSpan: ParentSpanResolver,
  activeToolSpans: Map<string, Span>,
  mcpServers: ClaudeAgentSDKMcpServersConfig | undefined,
  localToolHookNames: Set<string>,
  skipLocalToolHooks: boolean,
  subAgentDetailsByToolUseId: Map<string, SubAgentDetails>,
  subAgentSpans: Map<string, Span>,
  endedSubAgentSpans: Set<string>,
  transcriptUsageState: TranscriptUsageState,
  taskIdToToolUseId: Map<string, string>,
): {
  postToolUse: ClaudeAgentSDKHookCallback;
  postToolUseFailure: ClaudeAgentSDKHookCallback;
  preToolUse: ClaudeAgentSDKHookCallback;
  subagentStart: ClaudeAgentSDKHookCallback;
  subagentStop: ClaudeAgentSDKHookCallback;
} {
  const preToolUse: ClaudeAgentSDKHookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse" || !toolUseID) {
      return {};
    }

    if (
      skipLocalToolHooks &&
      (isLocalToolUse(input.tool_name, mcpServers) ||
        localToolHookNames.has(input.tool_name))
    ) {
      return {};
    }

    const parsed = parseToolName(input.tool_name);
    const toolSpan = startBaseSpan(
      withSpanInstrumentationName(
        {
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
          parent: await resolveParentSpan(toolUseID, {
            agentId: input.agent_id,
          }),
          spanAttributes: { type: SpanTypeAttribute.TOOL },
        },
        INSTRUMENTATION_NAMES.CLAUDE_AGENT_SDK,
      ),
    );

    activeToolSpans.set(toolUseID, toolSpan);
    return {};
  };

  const postToolUse: ClaudeAgentSDKHookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "PostToolUse" || !toolUseID) {
      return {};
    }

    if (
      skipLocalToolHooks &&
      (isLocalToolUse(input.tool_name, mcpServers) ||
        localToolHookNames.has(input.tool_name))
    ) {
      return {};
    }

    const subAgentSpan = subAgentSpans.get(toolUseID);
    const toolSpan = activeToolSpans.get(toolUseID);
    if (subAgentSpan) {
      if (endedSubAgentSpans.has(toolUseID)) {
        return {};
      }

      try {
        const response = input.tool_response as
          | Record<string, unknown>
          | undefined;
        const metadata: Record<string, unknown> = {
          ...subAgentDetailsToMetadata(
            subAgentDetailsByToolUseId.get(toolUseID),
          ),
        };
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

      if (toolSpan) {
        try {
          toolSpan.log({ output: input.tool_response });
        } finally {
          toolSpan.end();
          activeToolSpans.delete(toolUseID);
        }
      }

      return {};
    }

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

    if (
      skipLocalToolHooks &&
      (isLocalToolUse(input.tool_name, mcpServers) ||
        localToolHookNames.has(input.tool_name))
    ) {
      return {};
    }

    const subAgentSpan = subAgentSpans.get(toolUseID);
    const toolSpan = activeToolSpans.get(toolUseID);
    if (subAgentSpan) {
      if (endedSubAgentSpans.has(toolUseID)) {
        return {};
      }

      try {
        subAgentSpan.log({
          error: input.error,
          metadata: subAgentDetailsToMetadata(
            subAgentDetailsByToolUseId.get(toolUseID),
          ),
        });
      } finally {
        subAgentSpan.end();
        endedSubAgentSpans.add(toolUseID);
      }

      if (toolSpan) {
        const parsed = parseToolName(input.tool_name);
        try {
          toolSpan.log({
            error: input.error,
            metadata: {
              "claude_agent_sdk.is_interrupt": input.is_interrupt,
              "claude_agent_sdk.session_id": input.session_id,
              "claude_agent_sdk.raw_tool_name": parsed.rawToolName,
              "gen_ai.tool.call.id": toolUseID,
              "gen_ai.tool.name": parsed.toolName,
              ...(parsed.mcpServer && { "mcp.server": parsed.mcpServer }),
            },
          });
        } finally {
          toolSpan.end();
          activeToolSpans.delete(toolUseID);
        }
      }

      return {};
    }

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

  const subagentStart: ClaudeAgentSDKHookCallback = async (
    input,
    toolUseID,
  ) => {
    if (input.hook_event_name !== "SubagentStart" || !toolUseID) {
      return {};
    }

    const details = upsertSubAgentDetails(
      subAgentDetailsByToolUseId,
      toolUseID,
      {
        agentId: input.agent_id,
        agentType: input.agent_type,
        toolUseId: toolUseID,
      },
    );

    const subAgentSpan = subAgentSpans.get(toolUseID);
    if (subAgentSpan && !endedSubAgentSpans.has(toolUseID)) {
      subAgentSpan.log({
        metadata: subAgentDetailsToMetadata(details),
      });
    }

    return {};
  };

  const subagentStop: ClaudeAgentSDKHookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== "SubagentStop" || !toolUseID) {
      return {};
    }

    const details = upsertSubAgentDetails(
      subAgentDetailsByToolUseId,
      toolUseID,
      {
        agentId: input.agent_id,
        agentType: input.agent_type,
        toolUseId: toolUseID,
      },
    );
    if (input.agent_transcript_path) {
      const parentToolUseId =
        taskIdToToolUseId.get(input.agent_id) ?? toolUseID;
      transcriptUsageState.subagentTranscriptPathByToolUseId.set(
        parentToolUseId,
        input.agent_transcript_path,
      );
    }
    const subAgentSpan = subAgentSpans.get(toolUseID);
    if (!subAgentSpan || endedSubAgentSpans.has(toolUseID)) {
      return {};
    }

    const metadata = {
      ...subAgentDetailsToMetadata(details),
      "claude_agent_sdk.stop_hook_active": input.stop_hook_active,
    };

    try {
      subAgentSpan.log({
        metadata,
        output: input.last_assistant_message,
      });
    } finally {
      subAgentSpan.end();
      endedSubAgentSpans.add(toolUseID);
    }

    return {};
  };

  return {
    postToolUse,
    postToolUseFailure,
    preToolUse,
    subagentStart,
    subagentStop,
  };
}

function injectTracingHooks(
  options: ClaudeAgentSDKQueryOptions,
  resolveParentSpan: ParentSpanResolver,
  activeToolSpans: Map<string, Span>,
  localToolHookNames: Set<string>,
  skipLocalToolHooks: boolean,
  subAgentDetailsByToolUseId: Map<string, SubAgentDetails>,
  subAgentSpans: Map<string, Span>,
  endedSubAgentSpans: Set<string>,
  transcriptUsageState: TranscriptUsageState,
  taskIdToToolUseId: Map<string, string>,
): ClaudeAgentSDKQueryOptions {
  const {
    preToolUse,
    postToolUse,
    postToolUseFailure,
    subagentStart,
    subagentStop,
  } = createToolTracingHooks(
    resolveParentSpan,
    activeToolSpans,
    options.mcpServers,
    localToolHookNames,
    skipLocalToolHooks,
    subAgentDetailsByToolUseId,
    subAgentSpans,
    endedSubAgentSpans,
    transcriptUsageState,
    taskIdToToolUseId,
  );
  // SessionStart can occur before programmatic hooks are registered in the
  // supported SDK versions. UserPromptSubmit carries the same base hook fields
  // after registration, while SessionEnd remains a useful final fallback.
  const captureRootTranscriptPath: ClaudeAgentSDKHookCallback = async (
    input,
  ) => {
    if (
      (input.hook_event_name === "SessionStart" ||
        input.hook_event_name === "SessionEnd" ||
        input.hook_event_name === "UserPromptSubmit") &&
      input.agent_id === undefined &&
      typeof input.transcript_path === "string"
    ) {
      transcriptUsageState.rootTranscriptPath = input.transcript_path;
    }
    return {};
  };

  const existingHooks = options.hooks ?? {};

  return {
    ...options,
    hooks: {
      ...existingHooks,
      SessionStart: [
        ...(existingHooks.SessionStart ?? []),
        {
          hooks: [captureRootTranscriptPath],
        } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
      SessionEnd: [
        ...(existingHooks.SessionEnd ?? []),
        {
          hooks: [captureRootTranscriptPath],
        } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
      UserPromptSubmit: [
        ...(existingHooks.UserPromptSubmit ?? []),
        {
          hooks: [captureRootTranscriptPath],
        } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
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
      SubagentStart: [
        ...(existingHooks.SubagentStart ?? []),
        {
          hooks: [subagentStart],
        } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
      SubagentStop: [
        ...(existingHooks.SubagentStop ?? []),
        {
          hooks: [subagentStop],
        } satisfies ClaudeAgentSDKHookCallbackMatcher,
      ],
    },
  };
}

type QueryState = {
  activeLlmSpansByParentToolUse: Map<string, Span>;
  activePartialMessageIdByParentKey: Map<string, string>;
  activeToolSpans: Map<string, Span>;
  conversationHistoryByParentKey: Map<string, ClaudeConversationMessage[]>;
  capturedPromptMessages: ClaudeAgentSDKMessage[] | undefined;
  currentMessageId: string | undefined;
  currentMessageStartTime: number;
  currentMessages: ClaudeAgentSDKMessage[];
  endedSubAgentSpans: Set<string>;
  finalOutputUsageMessageIds: Set<string>;
  finalResults: ClaudeConversationMessage[];
  options: ClaudeAgentSDKQueryOptions;
  originalPrompt: string | AsyncIterable<ClaudeAgentSDKMessage> | undefined;
  processing: Promise<void>;
  promptDone: Promise<void>;
  promptMessagesByParentKey: Map<string, ClaudeConversationMessage[]>;
  promptStarted: () => boolean;
  promptSourcePriorityByParentKey: Map<string, number>;
  span: Span;
  subAgentDetailsByToolUseId: Map<string, SubAgentDetails>;
  subAgentSpans: Map<string, Span>;
  taskIdToToolUseId: Map<string, string>;
  latestLlmParentBySubAgentToolUse: Map<string, string>;
  latestRootLlmParentRef: { value: string | undefined };
  toolUseToParent: Map<string, string | null>;
  transcriptUsageState: TranscriptUsageState;
  usageByMessageId: Map<string, ClaudeAgentSDKUsage>;
  localToolContext: ClaudeAgentSDKLocalToolContext;
};

function setSubAgentPromptMessages(
  state: QueryState,
  parentToolUseId: string,
  promptMessages: ClaudeConversationMessage[],
  source: SubAgentPromptSource,
): void {
  if (promptMessages.length === 0) {
    return;
  }

  const parentKey = llmParentKey(parentToolUseId);
  const sourcePriority = SUB_AGENT_PROMPT_SOURCE_PRIORITY[source];
  const currentPriority =
    state.promptSourcePriorityByParentKey.get(parentKey) ?? -1;

  if (sourcePriority > currentPriority) {
    state.promptMessagesByParentKey.set(parentKey, promptMessages);
    state.promptSourcePriorityByParentKey.set(parentKey, sourcePriority);
  }
}

function getConversationHistory(
  state: QueryState,
  parentKey: string,
): ClaudeConversationMessage[] {
  let conversationHistory = state.conversationHistoryByParentKey.get(parentKey);
  if (!conversationHistory) {
    conversationHistory = [];
    state.conversationHistoryByParentKey.set(parentKey, conversationHistory);
  }

  return conversationHistory;
}

async function finalizeCurrentMessageGroup(state: QueryState): Promise<void> {
  if (state.currentMessages.length === 0) {
    return;
  }

  const parentToolUseId = state.currentMessages[0]?.parent_tool_use_id ?? null;
  const parentKey = llmParentKey(parentToolUseId);
  const conversationHistory = getConversationHistory(state, parentKey);
  const promptMessages = parentToolUseId
    ? (state.promptMessagesByParentKey.get(parentKey) ?? [])
    : buildRootPromptMessages(
        state.originalPrompt,
        state.capturedPromptMessages,
      );
  let parentSpan = await state.span.export();
  if (parentToolUseId) {
    const subAgentSpan = state.subAgentSpans.get(parentToolUseId);
    if (subAgentSpan) {
      parentSpan = await subAgentSpan.export();
    }
  }
  const existingLlmSpan = state.activeLlmSpansByParentToolUse.get(parentKey);
  const lastMessage = state.currentMessages[state.currentMessages.length - 1];
  const messageId = lastMessage?.message?.id;
  // Stream events carry the freshest counts, but they can be partial (a
  // `message_delta` reports only `output_tokens`), so layer them over the
  // assistant message's own usage rather than replacing it.
  const usage = mergeUsage(
    copyUsage(lastMessage?.message?.usage),
    messageId ? state.usageByMessageId.get(messageId) : undefined,
  );
  const hasFinalOutputUsage =
    messageId !== undefined && state.finalOutputUsageMessageIds.has(messageId);

  const llmSpanResult = await createLLMSpanForMessages(
    state.currentMessages,
    promptMessages,
    conversationHistory,
    state.options,
    state.currentMessageStartTime,
    parentSpan,
    usage,
    hasFinalOutputUsage,
    existingLlmSpan,
  );

  if (llmSpanResult) {
    if (parentToolUseId) {
      state.latestLlmParentBySubAgentToolUse.set(
        parentToolUseId,
        llmSpanResult.spanExport,
      );
    } else {
      state.latestRootLlmParentRef.value = llmSpanResult.spanExport;
    }

    if (llmSpanResult.finalMessage) {
      conversationHistory.push(llmSpanResult.finalMessage);
      state.finalResults.push(llmSpanResult.finalMessage);
    }

    if (messageId && !hasFinalOutputUsage && usage) {
      state.transcriptUsageState.pendingLlmUsageByContextKey.set(
        llmUsageContextKey(parentToolUseId, messageId),
        {
          messageId,
          span: llmSpanResult.span,
          usage,
        },
      );
    }
  }

  // Keep the active LLM parent visible until the finalized exported parent
  // reference has been published. Otherwise tool hooks can race this gap and
  // fall back to the broader sub-agent task span instead of the LLM span.
  state.activeLlmSpansByParentToolUse.delete(parentKey);

  if (messageId) {
    state.usageByMessageId.delete(messageId);
    state.finalOutputUsageMessageIds.delete(messageId);
    for (const [
      parent,
      activeMessageId,
    ] of state.activePartialMessageIdByParentKey) {
      if (activeMessageId === messageId) {
        state.activePartialMessageIdByParentKey.delete(parent);
      }
    }
  }

  state.currentMessages.length = 0;
}

function maybeTrackToolUseContext(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): void {
  seedTaskToolUseIdMapping(state.taskIdToToolUseId, message);

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
      typeof block.name === "string" &&
      isSubAgentDelegationToolName(block.name) &&
      typeof block.input === "object" &&
      block.input !== null
    ) {
      upsertSubAgentDetails(state.subAgentDetailsByToolUseId, block.id, {
        agentType: getStringProperty(block.input, "subagent_type"),
        description: getStringProperty(block.input, "description"),
        toolUseId: block.id,
      });

      const prompt = getStringProperty(block.input, "prompt");
      if (prompt) {
        setSubAgentPromptMessages(
          state,
          block.id,
          [{ content: prompt, role: "user" }],
          "delegation",
        );
      }
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
    state.subAgentDetailsByToolUseId,
    state.span,
    state.activeToolSpans,
    state.subAgentSpans,
    parentToolUseId,
  );
}

async function ensureSubAgentSpan(
  subAgentDetailsByToolUseId: Map<string, SubAgentDetails>,
  rootSpan: Span,
  activeToolSpans: Map<string, Span>,
  subAgentSpans: Map<string, Span>,
  parentToolUseId: string,
): Promise<Span> {
  const existingSpan = subAgentSpans.get(parentToolUseId);
  if (existingSpan) {
    return existingSpan;
  }

  const details = subAgentDetailsByToolUseId.get(parentToolUseId);
  const spanName = formatSubAgentSpanName(details);
  const parentToolSpan = activeToolSpans.get(parentToolUseId);
  const parentSpan = parentToolSpan
    ? await parentToolSpan.export()
    : await rootSpan.export();

  const subAgentSpan = startBaseSpan(
    withSpanInstrumentationName(
      {
        event: {
          metadata: subAgentDetailsToMetadata(details),
        },
        name: spanName,
        parent: parentSpan,
        spanAttributes: { type: SpanTypeAttribute.TASK },
      },
      INSTRUMENTATION_NAMES.CLAUDE_AGENT_SDK,
    ),
  );

  subAgentSpans.set(parentToolUseId, subAgentSpan);
  return subAgentSpan;
}

async function ensureActiveLlmSpanForParentToolUse(
  rootSpan: Span,
  activeLlmSpansByParentToolUse: Map<string, Span>,
  subAgentDetailsByToolUseId: Map<string, SubAgentDetails>,
  activeToolSpans: Map<string, Span>,
  subAgentSpans: Map<string, Span>,
  parentToolUseId: string | null,
  startTime: number,
): Promise<Span> {
  const parentKey = llmParentKey(parentToolUseId);
  const existingLlmSpan = activeLlmSpansByParentToolUse.get(parentKey);
  if (existingLlmSpan) {
    return existingLlmSpan;
  }

  let llmParentSpan = await rootSpan.export();
  if (parentToolUseId) {
    const subAgentSpan = await ensureSubAgentSpan(
      subAgentDetailsByToolUseId,
      rootSpan,
      activeToolSpans,
      subAgentSpans,
      parentToolUseId,
    );
    llmParentSpan = await subAgentSpan.export();
  }

  const llmSpan = startBaseSpan(
    withSpanInstrumentationName(
      {
        name: "anthropic.messages.create",
        parent: llmParentSpan,
        spanAttributes: {
          type: SpanTypeAttribute.LLM,
        },
        startTime,
      },
      INSTRUMENTATION_NAMES.CLAUDE_AGENT_SDK,
    ),
  );
  activeLlmSpansByParentToolUse.set(parentKey, llmSpan);
  return llmSpan;
}

async function maybeHandleTaskLifecycleMessage(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): Promise<boolean> {
  if (message.type !== "system") {
    return false;
  }

  if (
    message.subtype !== "task_started" &&
    message.subtype !== "task_progress" &&
    message.subtype !== "task_notification"
  ) {
    return false;
  }

  const toolUseId = resolveTaskToolUseId(state.taskIdToToolUseId, message);
  if (!toolUseId) {
    return true;
  }

  const details = upsertSubAgentDetails(
    state.subAgentDetailsByToolUseId,
    toolUseId,
    {
      description: getStringProperty(message, "description"),
      taskId: getStringProperty(message, "task_id"),
      taskType: getStringProperty(message, "task_type"),
      toolUseId,
      workflowName: getStringProperty(message, "workflow_name"),
    },
  );
  const subAgentSpan = await ensureSubAgentSpan(
    state.subAgentDetailsByToolUseId,
    state.span,
    state.activeToolSpans,
    state.subAgentSpans,
    toolUseId,
  );
  if (state.endedSubAgentSpans.has(toolUseId)) {
    return true;
  }

  const usage = message.usage;
  const usageTotalTokens = getNumberProperty(usage, "total_tokens");
  const usageToolUses = getNumberProperty(usage, "tool_uses");
  const usageDurationMs = getNumberProperty(usage, "duration_ms");
  const metadata: Record<string, unknown> = {
    ...subAgentDetailsToMetadata(details),
    "claude_agent_sdk.tool_use_id": toolUseId,
    ...(usageTotalTokens !== undefined && {
      "claude_agent_sdk.total_tokens": usageTotalTokens,
    }),
    ...(usageToolUses !== undefined && {
      "claude_agent_sdk.tool_use_count": usageToolUses,
    }),
    ...(usageDurationMs !== undefined && {
      "claude_agent_sdk.duration_ms": usageDurationMs,
    }),
  };

  if (message.subtype === "task_started") {
    const prompt = getStringProperty(message, "prompt");
    if (prompt) {
      setSubAgentPromptMessages(
        state,
        toolUseId,
        [{ content: prompt, role: "user" }],
        "lifecycle",
      );
    }
    subAgentSpan.log({
      input: prompt,
      metadata,
    });
    return true;
  }

  const summary = getStringProperty(message, "summary");
  if (summary) {
    metadata["claude_agent_sdk.summary"] = summary;
  }

  if (message.subtype === "task_progress") {
    const lastToolName = getStringProperty(message, "last_tool_name");
    if (lastToolName) {
      metadata["claude_agent_sdk.last_tool_name"] = lastToolName;
    }

    subAgentSpan.log({
      metadata,
      output: summary,
    });
    return true;
  }

  const status = getStringProperty(message, "status");
  const outputFile = getStringProperty(message, "output_file");
  if (status) {
    metadata["claude_agent_sdk.task_status"] = status;
  }
  if (outputFile) {
    metadata["claude_agent_sdk.output_file"] = outputFile;
  }

  const output =
    summary || outputFile
      ? {
          ...(summary && { summary }),
          ...(outputFile && { output_file: outputFile }),
        }
      : undefined;

  try {
    subAgentSpan.log({
      metadata,
      output,
    });
  } finally {
    subAgentSpan.end();
    state.endedSubAgentSpans.add(toolUseId);
  }

  return true;
}

function handlePartialUsageMessage(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): boolean {
  if (message.type !== "stream_event") {
    return false;
  }

  const event = message.event;
  if (!event || typeof event !== "object") {
    return true;
  }

  const parentKey = llmParentKey(message.parent_tool_use_id ?? null);
  if (event.type === "message_start") {
    const messageId = event.message?.id;
    const usage = copyUsage(event.message?.usage);
    if (messageId) {
      state.activePartialMessageIdByParentKey.set(parentKey, messageId);
      if (usage) {
        state.usageByMessageId.set(messageId, usage);
      }
    }
    return true;
  }

  const messageId = state.activePartialMessageIdByParentKey.get(parentKey);
  if (!messageId) {
    return true;
  }

  if (event.type === "message_delta") {
    const update = copyUsage(event.usage);
    if (update) {
      const usage = state.usageByMessageId.get(messageId) ?? {};
      Object.assign(usage, update);
      state.usageByMessageId.set(messageId, usage);
      if (update.output_tokens !== undefined) {
        state.finalOutputUsageMessageIds.add(messageId);
      }
    }
  } else if (event.type === "message_stop") {
    state.activePartialMessageIdByParentKey.delete(parentKey);
  }

  return true;
}

async function handleStreamMessage(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): Promise<void> {
  if (handlePartialUsageMessage(state, message)) {
    return;
  }

  maybeTrackToolUseContext(state, message);
  if (await maybeHandleTaskLifecycleMessage(state, message)) {
    return;
  }
  await maybeStartSubAgentSpan(state, message);

  const messageParentToolUseId = message.parent_tool_use_id;
  if (messageParentToolUseId && message.type === "user") {
    const conversationMessage = conversationMessageFromSDKMessage(message);
    if (conversationMessage?.role === "user") {
      await finalizeCurrentMessageGroup(state);
      const parentKey = llmParentKey(messageParentToolUseId);
      const conversationHistory = getConversationHistory(state, parentKey);
      const currentPromptSourcePriority =
        state.promptSourcePriorityByParentKey.get(parentKey) ?? -1;
      const canUseAsInitialSidechainPrompt =
        conversationHistory.length === 0 &&
        currentPromptSourcePriority <
          SUB_AGENT_PROMPT_SOURCE_PRIORITY.sidechain &&
        !messageContentHasBlockType(message, "tool_result");

      if (!canUseAsInitialSidechainPrompt) {
        conversationHistory.push(conversationMessage);
        return;
      }

      setSubAgentPromptMessages(
        state,
        messageParentToolUseId,
        [conversationMessage],
        "sidechain",
      );
      return;
    }
  }

  const messageId = message.message?.id;
  if (messageId && messageId !== state.currentMessageId) {
    await finalizeCurrentMessageGroup(state);
    state.currentMessageId = messageId;
    state.currentMessageStartTime = getCurrentUnixTimestamp();
  }

  if (message.type === "assistant" && message.message?.usage) {
    const parentToolUseId = message.parent_tool_use_id ?? null;
    await ensureActiveLlmSpanForParentToolUse(
      state.span,
      state.activeLlmSpansByParentToolUse,
      state.subAgentDetailsByToolUseId,
      state.activeToolSpans,
      state.subAgentSpans,
      parentToolUseId,
      state.currentMessageStartTime,
    );

    state.currentMessages.push(message);
  }

  if (message.type !== "result") {
    return;
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

    try {
      await recoverUsageWithRetries(state.transcriptUsageState);
    } catch (error) {
      debugLogger.debug(
        "Could not recover Claude Agent SDK transcript usage",
        error,
      );
    }
    for (const pending of state.transcriptUsageState.pendingLlmUsageByContextKey.values()) {
      const cacheCreationTokens = pending.usage.cache_creation_input_tokens;
      const hasCacheCreationBreakdown =
        pending.usage.cache_creation?.ephemeral_5m_input_tokens !== undefined ||
        pending.usage.cache_creation?.ephemeral_1h_input_tokens !== undefined;
      if (
        hasCacheCreationBreakdown ||
        cacheCreationTokens === undefined ||
        cacheCreationTokens === 0
      ) {
        continue;
      }

      try {
        pending.span.log({
          metrics: extractAnthropicCacheTokens(0, cacheCreationTokens),
        });
      } catch (error) {
        debugLogger.debug(
          "Could not finalize Claude Agent SDK fallback cache usage",
          error,
        );
      }
    }

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
    for (const llmSpan of state.activeLlmSpansByParentToolUse.values()) {
      llmSpan.end();
    }
    state.activeLlmSpansByParentToolUse.clear();
    state.activePartialMessageIdByParentKey.clear();
    state.finalOutputUsageMessageIds.clear();
    state.usageByMessageId.clear();
    state.transcriptUsageState.pendingLlmUsageByContextKey.clear();
    state.transcriptUsageState.subagentTranscriptPathByToolUseId.clear();
    state.transcriptUsageState.rootTranscriptPath = undefined;

    for (const toolSpan of state.activeToolSpans.values()) {
      toolSpan.end();
    }
    state.activeToolSpans.clear();

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

        const span = startBaseSpan(
          withSpanInstrumentationName(
            {
              name: "Claude Agent",
              spanAttributes: {
                type: SpanTypeAttribute.TASK,
              },
            },
            INSTRUMENTATION_NAMES.CLAUDE_AGENT_SDK,
          ),
        );
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
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
          console.error("Error extracting input for Claude Agent SDK:", error);
        }

        const activeToolSpans = new Map<string, Span>();
        const activeLlmSpansByParentToolUse = new Map<string, Span>();
        const conversationHistoryByParentKey = new Map<
          string,
          ClaudeConversationMessage[]
        >();
        const subAgentSpans = new Map<string, Span>();
        const endedSubAgentSpans = new Set<string>();
        const toolUseToParent = new Map<string, string | null>();
        const latestLlmParentBySubAgentToolUse = new Map<string, string>();
        const latestRootLlmParentRef = {
          value: undefined as string | undefined,
        };
        const subAgentDetailsByToolUseId = new Map<string, SubAgentDetails>();
        const taskIdToToolUseId = new Map<string, string>();
        const promptMessagesByParentKey = new Map<
          string,
          ClaudeConversationMessage[]
        >();
        const promptSourcePriorityByParentKey = new Map<string, number>();
        const localToolContext = createClaudeLocalToolContext();
        const transcriptUsageState: TranscriptUsageState = {
          pendingLlmUsageByContextKey: new Map(),
          subagentTranscriptPathByToolUseId: new Map(),
        };
        const { hasLocalToolHandlers, localToolHookNames } =
          prepareLocalToolHandlersInMcpServers(options.mcpServers);
        const skipLocalToolHooks =
          options[CLAUDE_AGENT_SDK_SKIP_LOCAL_TOOL_HOOKS_OPTION] === true ||
          hasLocalToolHandlers;
        const resolveToolUseParentSpan: ParentSpanResolver = async (
          toolUseID,
          context,
        ) => {
          const trackedParentToolUseId = toolUseToParent.get(toolUseID);
          const parentToolUseId =
            trackedParentToolUseId ??
            (context?.agentId
              ? (taskIdToToolUseId.get(context.agentId) ?? null)
              : null);
          const parentKey = llmParentKey(parentToolUseId);
          const activeLlmSpan = activeLlmSpansByParentToolUse.get(parentKey);
          const latestLlmParent = parentToolUseId
            ? latestLlmParentBySubAgentToolUse.get(parentToolUseId)
            : latestRootLlmParentRef.value;

          // Tool spans should be siblings of the driving LLM turn, but we still
          // materialize that LLM span first so trace ordering reflects that the
          // tool call was produced by the model.
          if (!activeLlmSpan && !latestLlmParent) {
            await ensureActiveLlmSpanForParentToolUse(
              span,
              activeLlmSpansByParentToolUse,
              subAgentDetailsByToolUseId,
              activeToolSpans,
              subAgentSpans,
              parentToolUseId,
              getCurrentUnixTimestamp(),
            );
          }

          if (parentToolUseId) {
            const subAgentSpan = await ensureSubAgentSpan(
              subAgentDetailsByToolUseId,
              span,
              activeToolSpans,
              subAgentSpans,
              parentToolUseId,
            );
            return subAgentSpan.export();
          }

          return span.export();
        };

        localToolContext.resolveLocalToolParent = resolveToolUseParentSpan;
        setClaudeLocalToolParentResolver(resolveToolUseParentSpan);
        const optionsWithHooks = injectTracingHooks(
          options,
          resolveToolUseParentSpan,
          activeToolSpans,
          localToolHookNames,
          skipLocalToolHooks,
          subAgentDetailsByToolUseId,
          subAgentSpans,
          endedSubAgentSpans,
          transcriptUsageState,
          taskIdToToolUseId,
        );

        params.options = optionsWithHooks;
        event.arguments[0] = params;

        spans.set(event, {
          activeLlmSpansByParentToolUse,
          activePartialMessageIdByParentKey: new Map(),
          activeToolSpans,
          conversationHistoryByParentKey,
          capturedPromptMessages,
          currentMessageId: undefined,
          currentMessageStartTime: startTime,
          currentMessages: [],
          endedSubAgentSpans,
          finalOutputUsageMessageIds: new Set(),
          finalResults: [],
          options: optionsWithHooks,
          originalPrompt,
          processing: Promise.resolve(),
          promptDone,
          promptMessagesByParentKey,
          promptStarted: () => promptStarted,
          promptSourcePriorityByParentKey,
          span,
          subAgentDetailsByToolUseId,
          subAgentSpans,
          taskIdToToolUseId,
          latestLlmParentBySubAgentToolUse,
          latestRootLlmParentRef,
          toolUseToParent,
          transcriptUsageState,
          usageByMessageId: new Map(),
          localToolContext,
        });
      },

      end: (event) => {
        const state = spans.get(event);
        if (!state) {
          return;
        }

        const eventResult = bindClaudeLocalToolContextToAsyncIterable(
          event.result,
          state.localToolContext,
        );
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
                  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
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
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
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
