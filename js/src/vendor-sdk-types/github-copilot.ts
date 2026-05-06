/**
 * Vendored types for @github/copilot-sdk which our wrapper consumes.
 *
 * Should never be exposed to users of the SDK!
 *
 * Sourced from @github/copilot-sdk@0.3.0:
 *   dist/types.d.ts
 *   dist/generated/session-events.d.ts
 */

// ---------------------------------------------------------------------------
// Session event types (subset we care about)
// ---------------------------------------------------------------------------

/** Turn start — opens a new agentic turn */
export interface GitHubCopilotTurnStartData {
  turnId: string;
  interactionId?: string;
}

/** Turn end — closes the agentic turn */
export interface GitHubCopilotTurnEndData {
  turnId: string;
}

/** Final assistant message in a turn */
export interface GitHubCopilotAssistantMessageData {
  messageId: string;
  content: string;
  reasoningText?: string;
  toolRequests?: Array<{
    toolCallId: string;
    name: string;
    arguments?: Record<string, unknown>;
    mcpServerName?: string;
  }>;
  outputTokens?: number;
  parentToolCallId?: string;
}

/** Per-LLM-call usage metrics */
export interface GitHubCopilotUsageData {
  /** Model identifier (required) */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  duration?: number;
  ttftMs?: number;
  interTokenLatencyMs?: number;
  apiCallId?: string;
  providerCallId?: string;
  interactionId?: string;
  initiator?: string;
  reasoningEffort?: string;
  /** @deprecated use event.agentId instead */
  parentToolCallId?: string;
  copilotUsage?: {
    tokenDetails: Array<{
      batchSize: number;
      costPerBatch: number;
      tokenCount: number;
      tokenType: string;
    }>;
    totalNanoAiu: number;
  };
  quotaSnapshots?: Record<
    string,
    {
      entitlementRequests: number;
      isUnlimitedEntitlement: boolean;
      overage: number;
      usedRequests: number;
      remainingPercentage: number;
      resetDate?: string;
    }
  >;
}

/** User message event */
export interface GitHubCopilotUserMessageData {
  content: string;
  interactionId?: string;
}

/** Context window usage info */
export interface GitHubCopilotUsageInfoData {
  tokenLimit: number;
  currentTokens: number;
  messagesLength: number;
}

/** Idle event data (turn complete) */
export interface GitHubCopilotIdleData {
  aborted?: boolean;
}

/** Tool execution start */
export interface GitHubCopilotToolExecutionStartData {
  toolCallId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  mcpServerName?: string;
  mcpToolName?: string;
  /** @deprecated */
  parentToolCallId?: string;
}

/** Tool execution result */
export interface GitHubCopilotToolExecutionCompleteData {
  toolCallId: string;
  success: boolean;
  result?: {
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    isError?: boolean;
  };
  error?: {
    message?: string;
    code?: string;
  };
  /** @deprecated */
  parentToolCallId?: string;
}

/** Sub-agent started */
export interface GitHubCopilotSubagentStartedData {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  agentDescription: string;
}

/** Sub-agent completed */
export interface GitHubCopilotSubagentCompletedData {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  durationMs?: number;
  model?: string;
  totalTokens?: number;
  totalToolCalls?: number;
}

/** Sub-agent failed */
export interface GitHubCopilotSubagentFailedData {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  error: string;
  durationMs?: number;
  totalTokens?: number;
}

/** Union of all session events we handle */
export type GitHubCopilotTrackedEvent =
  | {
      type: "assistant.turn_start";
      agentId?: string;
      data: GitHubCopilotTurnStartData;
    }
  | {
      type: "assistant.turn_end";
      agentId?: string;
      data: GitHubCopilotTurnEndData;
    }
  | {
      type: "assistant.message";
      agentId?: string;
      data: GitHubCopilotAssistantMessageData;
    }
  | { type: "assistant.usage"; agentId?: string; data: GitHubCopilotUsageData }
  | {
      type: "user.message";
      agentId?: string;
      data: GitHubCopilotUserMessageData;
    }
  | {
      type: "session.usage_info";
      agentId?: string;
      data: GitHubCopilotUsageInfoData;
    }
  | { type: "session.idle"; agentId?: string; data: GitHubCopilotIdleData }
  | {
      type: "tool.execution_start";
      agentId?: string;
      data: GitHubCopilotToolExecutionStartData;
    }
  | {
      type: "tool.execution_complete";
      agentId?: string;
      data: GitHubCopilotToolExecutionCompleteData;
    }
  | {
      type: "subagent.started";
      agentId?: string;
      data: GitHubCopilotSubagentStartedData;
    }
  | {
      type: "subagent.completed";
      agentId?: string;
      data: GitHubCopilotSubagentCompletedData;
    }
  | {
      type: "subagent.failed";
      agentId?: string;
      data: GitHubCopilotSubagentFailedData;
    }
  | { type: string; agentId?: string; data?: unknown };

// ---------------------------------------------------------------------------
// Session / client types
// ---------------------------------------------------------------------------

export interface GitHubCopilotSessionHooks {
  onPreToolUse?: (
    input: {
      toolName: string;
      toolArgs: unknown;
      cwd: string;
      timestamp: number;
    },
    invocation: { sessionId: string },
  ) =>
    | Promise<{
        permissionDecision?: string;
        modifiedArgs?: unknown;
        additionalContext?: string;
      } | void>
    | {
        permissionDecision?: string;
        modifiedArgs?: unknown;
        additionalContext?: string;
      }
    | void;
  onPostToolUse?: (
    input: {
      toolName: string;
      toolArgs: unknown;
      toolResult: unknown;
      cwd: string;
      timestamp: number;
    },
    invocation: { sessionId: string },
  ) =>
    | Promise<{ modifiedResult?: unknown; additionalContext?: string } | void>
    | { modifiedResult?: unknown; additionalContext?: string }
    | void;
  onUserPromptSubmitted?: (
    input: { prompt: string; cwd: string; timestamp: number },
    invocation: { sessionId: string },
  ) =>
    | Promise<{ modifiedPrompt?: string; additionalContext?: string } | void>
    | { modifiedPrompt?: string; additionalContext?: string }
    | void;
  onSessionStart?: (
    input: {
      source: string;
      initialPrompt?: string;
      cwd: string;
      timestamp: number;
    },
    invocation: { sessionId: string },
  ) =>
    | Promise<{ additionalContext?: string } | void>
    | { additionalContext?: string }
    | void;
  onSessionEnd?: (
    input: {
      reason: string;
      finalMessage?: string;
      error?: string;
      cwd: string;
      timestamp: number;
    },
    invocation: { sessionId: string },
  ) => Promise<void> | void;
  onErrorOccurred?: (
    input: {
      error: string;
      errorContext: string;
      recoverable: boolean;
      cwd: string;
      timestamp: number;
    },
    invocation: { sessionId: string },
  ) =>
    | Promise<{
        errorHandling?: string;
        retryCount?: number;
        userNotification?: string;
      } | void>
    | { errorHandling?: string; retryCount?: number; userNotification?: string }
    | void;
}

export interface GitHubCopilotSessionConfig {
  model?: string;
  streaming?: boolean;
  onPermissionRequest: (
    request: unknown,
    invocation: { sessionId: string },
  ) => Promise<unknown> | unknown;
  hooks?: GitHubCopilotSessionHooks;
  provider?: {
    type?: string;
    baseUrl?: string;
    apiKey?: string;
    bearerToken?: string;
  };
  [key: string]: unknown;
}

export interface GitHubCopilotResumeSessionConfig {
  model?: string;
  streaming?: boolean;
  onPermissionRequest: (
    request: unknown,
    invocation: { sessionId: string },
  ) => Promise<unknown> | unknown;
  hooks?: GitHubCopilotSessionHooks;
  [key: string]: unknown;
}

export interface GitHubCopilotMessageOptions {
  prompt?: string;
  attachments?: unknown[];
  [key: string]: unknown;
}

export interface GitHubCopilotAssistantMessageEvent {
  type: "assistant.message";
  agentId?: string;
  data: GitHubCopilotAssistantMessageData;
  id: string;
  timestamp: string;
}

export interface GitHubCopilotSession {
  on(handler: (event: GitHubCopilotTrackedEvent) => void): () => void;
  on<K extends string>(
    eventType: K,
    handler: (event: GitHubCopilotTrackedEvent & { type: K }) => void,
  ): () => void;
  send(options: GitHubCopilotMessageOptions): Promise<string>;
  sendAndWait(
    options: GitHubCopilotMessageOptions,
    timeout?: number,
  ): Promise<GitHubCopilotAssistantMessageEvent | undefined>;
  disconnect(): Promise<void>;
}

export interface GitHubCopilotClient {
  createSession(
    config: GitHubCopilotSessionConfig,
  ): Promise<GitHubCopilotSession>;
  resumeSession(
    sessionId: string,
    config: GitHubCopilotResumeSessionConfig,
  ): Promise<GitHubCopilotSession>;
}
