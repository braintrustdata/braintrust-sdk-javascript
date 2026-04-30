/**
 * Vendored types for @cursor/sdk used by Braintrust instrumentation.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields we read, wrap, or log.
 */

export interface CursorSDKModule {
  Agent: CursorSDKAgentClass;
  [key: string]: unknown;
}

export interface CursorSDKAgentClass {
  create(options: CursorSDKAgentOptions): Promise<CursorSDKAgent>;
  resume(
    agentId: string,
    options?: Partial<CursorSDKAgentOptions>,
  ): Promise<CursorSDKAgent>;
  prompt(
    message: string | CursorSDKUserMessage,
    options?: CursorSDKAgentOptions,
  ): Promise<CursorSDKRunResult>;
  [key: string]: unknown;
}

export interface CursorSDKAgent {
  readonly agentId?: string;
  readonly model?: CursorSDKModelSelection;
  send(
    message: string | CursorSDKUserMessage,
    options?: CursorSDKSendOptions,
  ): Promise<CursorSDKRun>;
  close?: () => void;
  reload?: () => Promise<void>;
  [Symbol.asyncDispose]?: () => Promise<void>;
  [key: string | symbol]: unknown;
}

export interface CursorSDKAgentOptions {
  agentId?: string;
  apiKey?: string;
  model?: CursorSDKModelSelection;
  name?: string;
  local?: {
    cwd?: string | string[];
    settingSources?: string[];
    sandboxOptions?: { enabled?: boolean };
  };
  cloud?: {
    env?: { type?: "cloud" | "pool" | "machine"; name?: string };
    repos?: Array<{ url?: string; startingRef?: string; prUrl?: string }>;
    autoCreatePR?: boolean;
    workOnCurrentBranch?: boolean;
    skipReviewerRequest?: boolean;
  };
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, CursorSDKAgentDefinition>;
  [key: string]: unknown;
}

export interface CursorSDKAgentDefinition {
  description?: string;
  prompt?: string;
  model?: CursorSDKModelSelection | "inherit";
  mcpServers?: unknown[];
}

export interface CursorSDKSendOptions {
  model?: CursorSDKModelSelection;
  mcpServers?: Record<string, unknown>;
  onDelta?: (args: {
    update: CursorSDKInteractionUpdate;
  }) => void | Promise<void>;
  onStep?: (args: { step: CursorSDKConversationStep }) => void | Promise<void>;
  local?: {
    force?: boolean;
  };
  [key: string]: unknown;
}

export interface CursorSDKModelSelection {
  id?: string;
  params?: Array<{ id?: string; value?: string }>;
}

export interface CursorSDKUserMessage {
  text?: string;
  images?: CursorSDKImage[];
  [key: string]: unknown;
}

export type CursorSDKImage =
  | {
      url?: string;
      dimension?: CursorSDKImageDimension;
      [key: string]: unknown;
    }
  | {
      data?: string;
      mimeType?: string;
      dimension?: CursorSDKImageDimension;
      [key: string]: unknown;
    };

export interface CursorSDKImageDimension {
  width?: number;
  height?: number;
}

export type CursorSDKRunStatus = "running" | "finished" | "error" | "cancelled";

export type CursorSDKRunOperation =
  | "stream"
  | "wait"
  | "cancel"
  | "conversation";

export interface CursorSDKRun {
  readonly id?: string;
  readonly agentId?: string;
  readonly status?: CursorSDKRunStatus;
  readonly result?: string;
  readonly model?: CursorSDKModelSelection;
  readonly durationMs?: number;
  readonly git?: CursorSDKRunGitInfo;
  readonly createdAt?: number;
  stream(): AsyncGenerator<CursorSDKMessage, void>;
  wait(): Promise<CursorSDKRunResult>;
  conversation(): Promise<CursorSDKConversationTurn[]>;
  cancel?: () => Promise<void>;
  supports?: (operation: CursorSDKRunOperation) => boolean;
  unsupportedReason?: (operation: CursorSDKRunOperation) => string | undefined;
  onDidChangeStatus?: (
    listener: (status: CursorSDKRunStatus) => void,
  ) => () => void;
  [key: string]: unknown;
}

export interface CursorSDKRunResult {
  id?: string;
  status?: Exclude<CursorSDKRunStatus, "running">;
  result?: string;
  model?: CursorSDKModelSelection;
  durationMs?: number;
  git?: CursorSDKRunGitInfo;
  [key: string]: unknown;
}

export interface CursorSDKRunGitInfo {
  branches?: Array<{ repoUrl?: string; branch?: string; prUrl?: string }>;
}

export type CursorSDKMessage =
  | CursorSDKSystemMessage
  | CursorSDKUserMessageEvent
  | CursorSDKAssistantMessage
  | CursorSDKThinkingMessage
  | CursorSDKToolUseMessage
  | CursorSDKStatusMessage
  | CursorSDKTaskMessage
  | CursorSDKRequestMessage
  | { type?: string; [key: string]: unknown };

export interface CursorSDKSystemMessage {
  type: "system";
  subtype?: "init";
  agent_id?: string;
  run_id?: string;
  model?: CursorSDKModelSelection;
  tools?: string[];
}

export interface CursorSDKUserMessageEvent {
  type: "user";
  agent_id?: string;
  run_id?: string;
  message?: { role?: "user"; content?: CursorSDKTextBlock[] };
}

export interface CursorSDKAssistantMessage {
  type: "assistant";
  agent_id?: string;
  run_id?: string;
  message?: {
    role?: "assistant";
    content?: Array<CursorSDKTextBlock | CursorSDKToolUseBlock>;
  };
}

export interface CursorSDKThinkingMessage {
  type: "thinking";
  agent_id?: string;
  run_id?: string;
  text?: string;
  thinking_duration_ms?: number;
}

export interface CursorSDKToolUseMessage {
  type: "tool_call";
  agent_id?: string;
  run_id?: string;
  call_id?: string;
  name?: string;
  status?: "running" | "completed" | "error";
  args?: unknown;
  result?: unknown;
  truncated?: { args?: boolean; result?: boolean };
}

export interface CursorSDKStatusMessage {
  type: "status";
  agent_id?: string;
  run_id?: string;
  status?: string;
  message?: string;
}

export interface CursorSDKTaskMessage {
  type: "task";
  agent_id?: string;
  run_id?: string;
  status?: string;
  text?: string;
}

export interface CursorSDKRequestMessage {
  type: "request";
  agent_id?: string;
  run_id?: string;
  request_id?: string;
}

export interface CursorSDKTextBlock {
  type?: "text";
  text?: string;
}

export interface CursorSDKToolUseBlock {
  type?: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

export type CursorSDKInteractionUpdate =
  | {
      type: "text-delta" | "thinking-delta";
      text?: string;
      [key: string]: unknown;
    }
  | {
      type: "thinking-completed";
      thinkingDurationMs?: number;
      [key: string]: unknown;
    }
  | {
      type: "tool-call-started" | "partial-tool-call" | "tool-call-completed";
      callId?: string;
      toolCall?: CursorSDKToolCall;
      modelCallId?: string;
      status?: string;
      [key: string]: unknown;
    }
  | {
      type: "token-delta";
      tokens?: number;
      [key: string]: unknown;
    }
  | {
      type: "turn-ended";
      usage?: CursorSDKUsage;
      [key: string]: unknown;
    }
  | {
      type:
        | "step-started"
        | "step-completed"
        | "user-message-appended"
        | "summary"
        | "summary-started"
        | "summary-completed"
        | "shell-output-delta";
      [key: string]: unknown;
    }
  | { type?: string; [key: string]: unknown };

export interface CursorSDKUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CursorSDKToolCall {
  type?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  truncated?: { args?: boolean; result?: boolean };
  status?: "running" | "completed" | "error";
  [key: string]: unknown;
}

export type CursorSDKConversationTurn =
  | {
      type?: "agentConversationTurn";
      turn?: {
        userMessage?: { text?: string };
        steps?: CursorSDKConversationStep[];
      };
      [key: string]: unknown;
    }
  | {
      type?: "shellConversationTurn";
      turn?: {
        shellCommand?: { command?: string; workingDirectory?: string };
        shellOutput?: { stdout?: string; stderr?: string; exitCode?: number };
      };
      [key: string]: unknown;
    };

export type CursorSDKConversationStep =
  | {
      type?: "assistantMessage";
      message?: { text?: string };
      [key: string]: unknown;
    }
  | {
      type?: "thinkingMessage";
      message?: { text?: string; thinkingDurationMs?: number };
      [key: string]: unknown;
    }
  | {
      type?: "toolCall";
      message?: CursorSDKToolCall;
      [key: string]: unknown;
    };
