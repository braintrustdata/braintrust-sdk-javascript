/**
 * Vendored types for @earendil-works/pi-coding-agent used by Braintrust
 * instrumentation.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields we read, wrap, or log.
 */

export interface PiCodingAgentModule {
  AgentSession: PiAgentSessionClass;
  [key: string]: unknown;
}

export interface PiAgentSessionClass {
  prototype: PiAgentSession;
  new (...args: unknown[]): PiAgentSession;
  [key: string]: unknown;
}

export interface PiAgentSession {
  readonly agent?: PiAgent;
  readonly model?: PiModel;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly thinkingLevel?: string;
  prompt(text: string, options?: PiPromptOptions): Promise<void>;
  getActiveToolNames?: () => string[];
  dispose?: () => void;
  [key: string | symbol]: unknown;
}

export interface PiPromptOptions {
  images?: PiImageContent[];
  expandPromptTemplates?: boolean;
  source?: "interactive" | "rpc" | "extension" | string;
  streamingBehavior?: "steer" | "followUp";
  preflightResult?: (success: boolean) => void;
  [key: string]: unknown;
}

export interface PiAgent {
  streamFn: PiStreamFn;
  subscribe(listener: PiAgentEventListener): () => void;
  readonly state?: {
    model?: PiModel;
    systemPrompt?: string;
    tools?: PiTool[];
    [key: string]: unknown;
  };
  readonly sessionId?: string;
  [key: string | symbol]: unknown;
}

export type PiAgentEventListener = (
  event: PiAgentEvent,
  signal: AbortSignal,
) => Promise<void> | void;

export type PiAgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiMessage[] }
  | { type: "turn_start"; turnIndex: number; timestamp: number }
  | {
      type: "turn_end";
      turnIndex: number;
      message: PiMessage;
      toolResults: PiToolResultMessage[];
    }
  | { type: "message_start"; message: PiMessage }
  | {
      type: "message_update";
      message: PiMessage;
      assistantMessageEvent?: PiAssistantMessageEvent;
    }
  | { type: "message_end"; message: PiMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

export type PiStreamFn = (
  model: PiModel,
  context: PiContext,
  options?: PiSimpleStreamOptions,
) => PiAssistantMessageEventStream | Promise<PiAssistantMessageEventStream>;

export interface PiSimpleStreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string>;
  reasoning?: string;
  transport?: string;
  cacheRetention?: string;
  sessionId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PiModel {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface PiContext {
  systemPrompt?: string;
  messages: PiMessage[];
  tools?: PiTool[];
}

export interface PiTool {
  name: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export type PiMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | { role?: string; [key: string]: unknown };

export interface PiUserMessage {
  role: "user";
  content: string | PiUserContent[];
  timestamp?: number;
  [key: string]: unknown;
}

type PiUserContent = PiTextContent | PiImageContent;

export interface PiTextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
  [key: string]: unknown;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
  [key: string]: unknown;
}

export interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  tokens?: number;
  [key: string]: unknown;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: Array<PiTextContent | PiThinkingContent | PiToolCall>;
  api?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<PiTextContent | PiImageContent>;
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

export type PiAssistantMessageEvent =
  | { type: "start"; partial: PiAssistantMessage }
  | { type: "done"; message: PiAssistantMessage }
  | { type: "error"; error: PiAssistantMessage }
  | { type?: string; partial?: PiAssistantMessage; [key: string]: unknown };

export interface PiAssistantMessageEventStream extends AsyncIterable<PiAssistantMessageEvent> {
  result(): Promise<PiAssistantMessage>;
  [key: string | symbol]: unknown;
}
