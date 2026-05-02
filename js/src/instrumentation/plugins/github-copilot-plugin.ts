import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers } from "../../isomorph";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import {
  extractAnthropicCacheTokens,
  finalizeAnthropicTokens,
} from "../../wrappers/anthropic-tokens-util";
import type { AnthropicTokenMetrics } from "../../wrappers/anthropic-tokens-util";
import { gitHubCopilotChannels } from "./github-copilot-channels";
import type {
  GitHubCopilotSession,
  GitHubCopilotSessionConfig,
  GitHubCopilotSessionHooks,
  GitHubCopilotTrackedEvent,
  GitHubCopilotUsageData,
} from "../../vendor-sdk-types/github-copilot";

const ROOT_AGENT_KEY = "__root__";

function agentKey(agentId: string | undefined): string {
  return agentId ?? ROOT_AGENT_KEY;
}

function getStringProperty(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object" || !(key in obj)) {
    return undefined;
  }
  const value = Reflect.get(obj as object, key);
  return typeof value === "string" ? value : undefined;
}

export function extractMetricsFromUsage(usage: GitHubCopilotUsageData): {
  metrics: AnthropicTokenMetrics;
  metadata: Record<string, unknown>;
} {
  const metrics: AnthropicTokenMetrics = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    ...extractAnthropicCacheTokens(
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    ),
  };

  if (usage.reasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = usage.reasoningTokens;
    metrics.reasoning_tokens = usage.reasoningTokens;
  }

  Object.assign(metrics, finalizeAnthropicTokens(metrics));

  const metadata: Record<string, unknown> = {
    model: usage.model,
  };

  if (usage.cost !== undefined) {
    metadata["github_copilot.cost"] = usage.cost;
  }
  if (usage.duration !== undefined) {
    metadata["github_copilot.duration_ms"] = usage.duration;
  }
  if (usage.ttftMs !== undefined) {
    metadata["github_copilot.time_to_first_token_ms"] = usage.ttftMs;
  }
  if (usage.interTokenLatencyMs !== undefined) {
    metadata["github_copilot.intertoken_latency_ms"] =
      usage.interTokenLatencyMs;
  }
  if (usage.apiCallId !== undefined) {
    metadata["github_copilot.api_call_id"] = usage.apiCallId;
  }
  if (usage.providerCallId !== undefined) {
    metadata["github_copilot.provider_call_id"] = usage.providerCallId;
  }
  if (usage.interactionId !== undefined) {
    metadata["github_copilot.interaction_id"] = usage.interactionId;
  }
  if (usage.initiator !== undefined) {
    metadata["github_copilot.initiator"] = usage.initiator;
  }
  if (usage.reasoningEffort !== undefined) {
    metadata["github_copilot.reasoning_effort"] = usage.reasoningEffort;
  }
  if (usage.copilotUsage !== undefined) {
    metadata["github_copilot.copilot_usage"] = usage.copilotUsage;
  }
  if (usage.quotaSnapshots !== undefined) {
    metadata["github_copilot.quota_snapshots"] = usage.quotaSnapshots;
  }

  return { metadata, metrics };
}

// ---------------------------------------------------------------------------
// Session state — stores spans AND their exported ID strings (Promise<string>)
// because startSpan requires parent?: string, not a Span object.
// ---------------------------------------------------------------------------

type SpanWithId = { span: Span; id: Promise<string> };

type SessionState = {
  session: SpanWithId;
  // Active turn span per agentKey
  activeTurns: Map<string, SpanWithId>;
  // Last user message content per agentKey (for turn span input)
  pendingUserMessages: Map<string, string>;
  // Accumulated assistant message content for current LLM call, per agentKey
  currentMessageContent: Map<string, string>;
  // Active tool spans, keyed by toolCallId
  activeTools: Map<string, SpanWithId>;
  // Sub-agent spans, keyed by spawning toolCallId
  subAgents: Map<string, SpanWithId>;
  // agentId → spawning toolCallId (populated by subagent.started)
  agentIdToToolCallId: Map<string, string>;
  // Unsubscribe from session.on(handler)
  unsubscribeEvents?: () => void;
  // Async event processing chain (keeps ordering guarantees)
  processing: Promise<void>;
  // Aggregate session-level token counts
  totalInputTokens: number;
  totalOutputTokens: number;
};

function makeSpanWithId(span: Span): SpanWithId {
  return { span, id: span.export() };
}

async function getParentIdForAgent(
  state: SessionState,
  agentId: string | undefined,
): Promise<string> {
  if (agentId) {
    const toolCallId = state.agentIdToToolCallId.get(agentId);
    if (toolCallId) {
      const subAgent = state.subAgents.get(toolCallId);
      if (subAgent) {
        return subAgent.id;
      }
    }
  }
  return state.session.id;
}

async function getToolParentId(
  state: SessionState,
  agentId: string | undefined,
): Promise<string> {
  const turn = state.activeTurns.get(agentKey(agentId));
  return turn ? turn.id : state.session.id;
}

// ---------------------------------------------------------------------------
// Span lifecycle handlers (all async — they await parent IDs)
// ---------------------------------------------------------------------------

async function handleTurnStart(
  state: SessionState,
  agentId: string | undefined,
): Promise<void> {
  const key = agentKey(agentId);
  if (state.activeTurns.has(key)) {
    return;
  }

  const parentId = await getParentIdForAgent(state, agentId);
  const span = startSpan({
    name: "Copilot Turn",
    parent: parentId,
    spanAttributes: { type: SpanTypeAttribute.TASK },
  });

  const pendingUserMessage = state.pendingUserMessages.get(key);
  if (pendingUserMessage) {
    span.log({ input: pendingUserMessage });
    state.pendingUserMessages.delete(key);
  }

  state.activeTurns.set(key, makeSpanWithId(span));
}

function handleTurnEnd(state: SessionState, agentId: string | undefined): void {
  const key = agentKey(agentId);
  const turn = state.activeTurns.get(key);
  if (!turn) {
    return;
  }

  turn.span.end();
  state.activeTurns.delete(key);
  state.currentMessageContent.delete(key);
}

function handleAssistantMessage(
  state: SessionState,
  agentId: string | undefined,
  content: string,
): void {
  state.currentMessageContent.set(agentKey(agentId), content);
  const turn = state.activeTurns.get(agentKey(agentId));
  if (turn) {
    turn.span.log({ output: content });
  }
}

async function handleUsage(
  state: SessionState,
  agentId: string | undefined,
  usage: GitHubCopilotUsageData,
): Promise<void> {
  const key = agentKey(agentId);
  const turn = state.activeTurns.get(key);
  const parentId = turn ? await turn.id : await state.session.id;
  const content = state.currentMessageContent.get(key);

  const { metrics, metadata } = extractMetricsFromUsage(usage);

  const llmSpan = startSpan({
    name: "github.copilot.llm",
    parent: parentId,
    spanAttributes: { type: SpanTypeAttribute.LLM },
  });

  llmSpan.log({
    output: content ?? undefined,
    metadata,
    metrics,
  });

  llmSpan.end();

  state.currentMessageContent.delete(key);
  state.totalInputTokens += usage.inputTokens ?? 0;
  state.totalOutputTokens += usage.outputTokens ?? 0;
}

function handleUserMessage(
  state: SessionState,
  agentId: string | undefined,
  content: string,
): void {
  const key = agentKey(agentId);
  const turn = state.activeTurns.get(key);
  if (turn) {
    turn.span.log({ input: content });
  } else {
    state.pendingUserMessages.set(key, content);
  }
}

async function handleToolStart(
  state: SessionState,
  agentId: string | undefined,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  mcpServerName: string | undefined,
): Promise<void> {
  if (state.activeTools.has(toolCallId)) {
    return;
  }

  const parentId = await getToolParentId(state, agentId);
  const displayName = mcpServerName
    ? `tool: ${mcpServerName}/${toolName}`
    : `tool: ${toolName}`;

  const span = startSpan({
    name: displayName,
    parent: parentId,
    spanAttributes: { type: SpanTypeAttribute.TOOL },
  });

  const metadata: Record<string, unknown> = {
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": toolCallId,
  };
  if (mcpServerName) {
    metadata["mcp.server"] = mcpServerName;
  }

  span.log({ input: args, metadata });
  state.activeTools.set(toolCallId, makeSpanWithId(span));
}

function handleToolComplete(
  state: SessionState,
  toolCallId: string,
  success: boolean,
  result: unknown,
  error: { message?: string; code?: string } | undefined,
): void {
  const tool = state.activeTools.get(toolCallId);
  if (!tool) {
    return;
  }

  try {
    if (!success && error) {
      tool.span.log({ error: error.message ?? "tool execution failed" });
    } else {
      tool.span.log({ output: result });
    }
  } finally {
    tool.span.end();
    state.activeTools.delete(toolCallId);
  }
}

async function handleSubagentStarted(
  state: SessionState,
  agentId: string | undefined,
  toolCallId: string,
  agentDisplayName: string,
  agentDescription: string,
): Promise<void> {
  if (state.subAgents.has(toolCallId)) {
    return;
  }

  if (agentId) {
    state.agentIdToToolCallId.set(agentId, toolCallId);
  }

  const tool = state.activeTools.get(toolCallId);
  const parentId = tool ? await tool.id : await state.session.id;

  const span = startSpan({
    name: `Agent: ${agentDisplayName}`,
    parent: parentId,
    spanAttributes: { type: SpanTypeAttribute.TASK },
  });

  span.log({
    metadata: {
      "github_copilot.agent_name": agentDisplayName,
      "github_copilot.agent_description": agentDescription,
    },
  });

  state.subAgents.set(toolCallId, makeSpanWithId(span));
}

function handleSubagentCompleted(
  state: SessionState,
  toolCallId: string,
  model: string | undefined,
  totalTokens: number | undefined,
  totalToolCalls: number | undefined,
  durationMs: number | undefined,
): void {
  const subAgent = state.subAgents.get(toolCallId);
  if (!subAgent) {
    return;
  }

  try {
    const metadata: Record<string, unknown> = {};
    if (model !== undefined) {
      metadata["github_copilot.agent_model"] = model;
    }
    if (totalTokens !== undefined) {
      metadata["github_copilot.agent_total_tokens"] = totalTokens;
    }
    if (totalToolCalls !== undefined) {
      metadata["github_copilot.agent_tool_calls"] = totalToolCalls;
    }
    if (durationMs !== undefined) {
      metadata["github_copilot.agent_duration_ms"] = durationMs;
    }

    subAgent.span.log({ metadata });
  } finally {
    subAgent.span.end();
    state.subAgents.delete(toolCallId);
  }
}

function handleSubagentFailed(
  state: SessionState,
  toolCallId: string,
  error: string,
): void {
  const subAgent = state.subAgents.get(toolCallId);
  if (!subAgent) {
    return;
  }

  try {
    subAgent.span.log({ error });
  } finally {
    subAgent.span.end();
    state.subAgents.delete(toolCallId);
  }
}

function handleSessionEnd(
  state: SessionState,
  reason: string,
  error: string | undefined,
): void {
  try {
    for (const tool of state.activeTools.values()) {
      tool.span.end();
    }
    state.activeTools.clear();

    for (const subAgent of state.subAgents.values()) {
      subAgent.span.end();
    }
    state.subAgents.clear();

    for (const turn of state.activeTurns.values()) {
      turn.span.end();
    }
    state.activeTurns.clear();
    state.agentIdToToolCallId.clear();

    const sessionMetadata: Record<string, unknown> = {
      "github_copilot.end_reason": reason,
    };
    if (state.totalInputTokens > 0 || state.totalOutputTokens > 0) {
      sessionMetadata["github_copilot.total_input_tokens"] =
        state.totalInputTokens;
      sessionMetadata["github_copilot.total_output_tokens"] =
        state.totalOutputTokens;
    }

    if (error) {
      state.session.span.log({ error, metadata: sessionMetadata });
    } else {
      state.session.span.log({ metadata: sessionMetadata });
    }
  } finally {
    state.session.span.end();
  }
}

// ---------------------------------------------------------------------------
// Event dispatch — async so handlers can await parent IDs
// ---------------------------------------------------------------------------

async function dispatchEvent(
  state: SessionState,
  event: GitHubCopilotTrackedEvent,
): Promise<void> {
  switch (event.type) {
    case "user.message": {
      const content = getStringProperty(event.data, "content");
      if (content !== undefined) {
        handleUserMessage(state, event.agentId, content);
      }
      break;
    }
    case "assistant.turn_start": {
      await handleTurnStart(state, event.agentId);
      break;
    }
    case "assistant.message": {
      const content = getStringProperty(event.data, "content");
      if (content !== undefined) {
        handleAssistantMessage(state, event.agentId, content);
      }
      break;
    }
    case "assistant.usage": {
      const usage = event.data as GitHubCopilotUsageData;
      if (
        usage &&
        typeof usage === "object" &&
        typeof usage.model === "string"
      ) {
        await handleUsage(state, event.agentId, usage);
      }
      break;
    }
    case "assistant.turn_end": {
      handleTurnEnd(state, event.agentId);
      break;
    }
    case "tool.execution_start": {
      const d = event.data as {
        toolCallId?: string;
        toolName?: string;
        arguments?: Record<string, unknown>;
        mcpServerName?: string;
      };
      if (
        d &&
        typeof d.toolCallId === "string" &&
        typeof d.toolName === "string"
      ) {
        await handleToolStart(
          state,
          event.agentId,
          d.toolCallId,
          d.toolName,
          d.arguments,
          d.mcpServerName,
        );
      }
      break;
    }
    case "tool.execution_complete": {
      const d = event.data as {
        toolCallId?: string;
        success?: boolean;
        result?: unknown;
        error?: { message?: string; code?: string };
      };
      if (d && typeof d.toolCallId === "string") {
        handleToolComplete(
          state,
          d.toolCallId,
          d.success ?? false,
          d.result,
          d.error,
        );
      }
      break;
    }
    case "subagent.started": {
      const d = event.data as {
        toolCallId?: string;
        agentDisplayName?: string;
        agentDescription?: string;
      };
      if (d && typeof d.toolCallId === "string") {
        await handleSubagentStarted(
          state,
          event.agentId,
          d.toolCallId,
          d.agentDisplayName ?? "sub-agent",
          d.agentDescription ?? "",
        );
      }
      break;
    }
    case "subagent.completed": {
      const d = event.data as {
        toolCallId?: string;
        model?: string;
        totalTokens?: number;
        totalToolCalls?: number;
        durationMs?: number;
      };
      if (d && typeof d.toolCallId === "string") {
        handleSubagentCompleted(
          state,
          d.toolCallId,
          d.model,
          d.totalTokens,
          d.totalToolCalls,
          d.durationMs,
        );
      }
      break;
    }
    case "subagent.failed": {
      const d = event.data as { toolCallId?: string; error?: string };
      if (d && typeof d.toolCallId === "string") {
        handleSubagentFailed(
          state,
          d.toolCallId,
          d.error ?? "sub-agent failed",
        );
      }
      break;
    }
    case "session.usage_info": {
      const d = event.data as {
        tokenLimit?: number;
        currentTokens?: number;
        messagesLength?: number;
      };
      if (d && typeof d.currentTokens === "number") {
        state.session.span.log({
          metadata: {
            "github_copilot.context_window.limit": d.tokenLimit,
            "github_copilot.context_window.current": d.currentTokens,
            "github_copilot.context_window.messages": d.messagesLength,
          },
        });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Hooks injection and event subscription
// ---------------------------------------------------------------------------

function injectTracingHooks(
  config: GitHubCopilotSessionConfig,
  state: SessionState,
): void {
  const existingHooks: GitHubCopilotSessionHooks = config.hooks ?? {};

  const onSessionEnd: GitHubCopilotSessionHooks["onSessionEnd"] = async (
    input,
    invocation,
  ) => {
    try {
      await existingHooks.onSessionEnd?.(input, invocation);
    } finally {
      handleSessionEnd(state, input.reason, input.error);
      state.unsubscribeEvents?.();
    }
  };

  config.hooks = {
    ...existingHooks,
    onSessionEnd,
  };
}

function attachSessionEventListener(
  session: GitHubCopilotSession,
  state: SessionState,
): void {
  const handler = (event: GitHubCopilotTrackedEvent) => {
    state.processing = state.processing
      .then(() => dispatchEvent(state, event))
      .catch((err) => {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        console.error(
          "[Braintrust] Error processing GitHub Copilot SDK event:",
          err,
        );
      });
  };

  state.unsubscribeEvents = session.on(
    handler as (event: GitHubCopilotTrackedEvent) => void,
  );
}

function isGitHubCopilotSession(value: unknown): value is GitHubCopilotSession {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as GitHubCopilotSession).on === "function"
  );
}

// ---------------------------------------------------------------------------
// Plugin and handler factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSessionHandlers(
  sessionStates: WeakMap<object, SessionState>,
  configArgIndex: number,
  includeProviderMetadata: boolean,
): IsoChannelHandlers<any> {
  return {
    start: (event) => {
      const config = event.arguments[configArgIndex] as
        | GitHubCopilotSessionConfig
        | undefined;
      if (!config || typeof config !== "object") {
        return;
      }

      const sessionSpan = startSpan({
        name: "Copilot Session",
        spanAttributes: { type: SpanTypeAttribute.TASK },
      });

      const metadata: Record<string, unknown> = {};
      if (config.model) {
        metadata["github_copilot.model"] = config.model;
      }
      if (includeProviderMetadata && config.provider?.type) {
        metadata["github_copilot.provider_type"] = config.provider.type;
      }
      if (Object.keys(metadata).length > 0) {
        sessionSpan.log({ metadata });
      }

      const state: SessionState = {
        session: makeSpanWithId(sessionSpan),
        activeTurns: new Map(),
        pendingUserMessages: new Map(),
        currentMessageContent: new Map(),
        activeTools: new Map(),
        subAgents: new Map(),
        agentIdToToolCallId: new Map(),
        processing: Promise.resolve(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };

      injectTracingHooks(config, state);
      sessionStates.set(event, state);
    },

    asyncEnd: (event) => {
      const state = sessionStates.get(event);
      if (!state) {
        return;
      }

      const session = event.result;
      if (isGitHubCopilotSession(session)) {
        attachSessionEventListener(session, state);
      } else {
        state.session.span.end();
      }
      sessionStates.delete(event);
    },

    error: (event) => {
      const state = sessionStates.get(event);
      if (!state || !event.error) {
        return;
      }

      state.session.span.log({ error: event.error.message });
      state.session.span.end();
      sessionStates.delete(event);
    },
  };
}

export class GitHubCopilotPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToSessionChannels();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToSessionChannels(): void {
    const createChannel = gitHubCopilotChannels.createSession.tracingChannel();
    const resumeChannel = gitHubCopilotChannels.resumeSession.tracingChannel();

    const sessionStates = new WeakMap<object, SessionState>();

    const createHandlers = makeSessionHandlers(
      sessionStates,
      0, // config is arg 0 of createSession(config)
      true, // include provider metadata
    );
    const resumeHandlers = makeSessionHandlers(
      sessionStates,
      1, // config is arg 1 of resumeSession(sessionId, config)
      false, // resumeSession config has no provider field
    );

    createChannel.subscribe(createHandlers);
    resumeChannel.subscribe(resumeHandlers);

    this.unsubscribers.push(
      () => createChannel.unsubscribe(createHandlers),
      () => resumeChannel.unsubscribe(resumeHandlers),
    );
  }
}
