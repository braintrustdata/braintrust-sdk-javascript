/**
 * Vendored types for @openai/codex-sdk used by Braintrust instrumentation.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields we read, wrap, or log.
 */

export interface OpenAICodexClass {
  new (options?: OpenAICodexOptions): OpenAICodexClient;
  [key: string]: unknown;
}

export interface OpenAICodexClient {
  startThread(options?: OpenAICodexThreadOptions): OpenAICodexThread;
  resumeThread(
    id: string,
    options?: OpenAICodexThreadOptions,
  ): OpenAICodexThread;
  [key: string]: unknown;
}

export interface OpenAICodexThread {
  readonly id?: string | null;
  run(
    input: OpenAICodexInput,
    turnOptions?: OpenAICodexTurnOptions,
  ): Promise<OpenAICodexTurn>;
  runStreamed(
    input: OpenAICodexInput,
    turnOptions?: OpenAICodexTurnOptions,
  ): Promise<OpenAICodexStreamedTurn>;
  [key: string]: unknown;
}

export interface OpenAICodexOptions {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  config?: OpenAICodexConfigObject;
  env?: Record<string, string>;
}

type OpenAICodexConfigValue =
  | string
  | number
  | boolean
  | OpenAICodexConfigValue[]
  | OpenAICodexConfigObject;

interface OpenAICodexConfigObject {
  [key: string]: OpenAICodexConfigValue;
}

export type OpenAICodexApprovalMode =
  | "never"
  | "on-request"
  | "on-failure"
  | "untrusted";

export type OpenAICodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type OpenAICodexModelReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type OpenAICodexWebSearchMode = "disabled" | "cached" | "live";

export interface OpenAICodexThreadOptions {
  model?: string;
  sandboxMode?: OpenAICodexSandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: OpenAICodexModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: OpenAICodexWebSearchMode;
  webSearchEnabled?: boolean;
  approvalPolicy?: OpenAICodexApprovalMode;
  additionalDirectories?: string[];
}

export interface OpenAICodexTurnOptions {
  outputSchema?: unknown;
  signal?: AbortSignal;
}

export type OpenAICodexInput =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "local_image"; path: string }
      | { type?: string; [key: string]: unknown }
    >;

export interface OpenAICodexUsage {
  prompt_tokens?: number;
  input_tokens?: number;
  prompt_cached_tokens?: number;
  cached_input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  completion_reasoning_tokens?: number;
  reasoning_output_tokens?: number;
  totalTokens?: number;
  tokens?: number;
  total_tokens?: number;
}

export interface OpenAICodexTurn {
  items: OpenAICodexThreadItem[];
  finalResponse: string;
  usage: OpenAICodexUsage | null;
}

export interface OpenAICodexStreamedTurn {
  events: AsyncGenerator<OpenAICodexThreadEvent>;
}

export type OpenAICodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: OpenAICodexUsage }
  | { type: "turn.failed"; error: OpenAICodexThreadError }
  | { type: "item.started"; item: OpenAICodexThreadItem }
  | { type: "item.updated"; item: OpenAICodexThreadItem }
  | { type: "item.completed"; item: OpenAICodexThreadItem }
  | { type: "error"; message: string };

export interface OpenAICodexThreadError {
  message?: string;
  [key: string]: unknown;
}

export type OpenAICodexThreadItem =
  | OpenAICodexAgentMessageItem
  | OpenAICodexReasoningItem
  | OpenAICodexCommandExecutionItem
  | OpenAICodexFileChangeItem
  | OpenAICodexMcpToolCallItem
  | OpenAICodexWebSearchItem
  | OpenAICodexTodoListItem
  | OpenAICodexErrorItem;

export interface OpenAICodexAgentMessageItem {
  id?: string;
  type: "agent_message";
  text?: string;
}

export interface OpenAICodexReasoningItem {
  id?: string;
  type: "reasoning";
  text?: string;
}

export interface OpenAICodexCommandExecutionItem {
  id?: string;
  type: "command_execution";
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: "in_progress" | "completed" | "failed";
}

export interface OpenAICodexFileChangeItem {
  id?: string;
  type: "file_change";
  changes?: Array<{ path?: string; kind?: "add" | "delete" | "update" }>;
  status?: "completed" | "failed";
}

export interface OpenAICodexMcpToolCallItem {
  id?: string;
  type: "mcp_tool_call";
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: {
    content?: unknown;
    structured_content?: unknown;
  };
  error?: {
    message?: string;
  };
  status?: "in_progress" | "completed" | "failed";
}

export interface OpenAICodexWebSearchItem {
  id?: string;
  type: "web_search";
  query?: string;
}

export interface OpenAICodexTodoListItem {
  id?: string;
  type: "todo_list";
  items?: Array<{ text?: string; completed?: boolean }>;
}

export interface OpenAICodexErrorItem {
  id?: string;
  type: "error";
  message?: string;
}
