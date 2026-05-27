/**
 * Vendored types for @flue/runtime used by Braintrust instrumentation.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields we read, wrap, or log.
 */

export type FlueOperationKind = "prompt" | "skill" | "task" | "compact";

export interface FlueUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface FluePromptResponse {
  text?: string;
  data?: unknown;
  result?: unknown;
  usage?: FlueUsage;
  model?: {
    id?: string;
  };
  [key: string]: unknown;
}

export interface FlueCallOptions {
  model?: string;
  role?: string;
  thinkingLevel?: string;
  tools?: FlueToolDef[];
  signal?: AbortSignal;
  images?: unknown[];
  result?: unknown;
  schema?: unknown;
  [key: string]: unknown;
}

export interface FlueSkillOptions extends FlueCallOptions {
  args?: Record<string, unknown>;
}

export interface FlueTaskOptions extends FlueCallOptions {
  cwd?: string;
}

export interface FlueToolDef {
  name?: string;
  description?: string;
  parameters?: unknown;
  execute?: unknown;
  [key: string]: unknown;
}

export interface FlueCallHandle<T = unknown> extends PromiseLike<T> {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

export interface FlueSession {
  readonly name?: string;
  prompt(text: string, options?: FlueCallOptions): FlueCallHandle<unknown>;
  skill(name: string, options?: FlueSkillOptions): FlueCallHandle<unknown>;
  task(text: string, options?: FlueTaskOptions): FlueCallHandle<unknown>;
  compact(): Promise<void>;
  [key: string | symbol]: unknown;
}

export interface FlueSessions {
  get(name?: string, options?: unknown): Promise<FlueSession>;
  create(name?: string, options?: unknown): Promise<FlueSession>;
  [key: string | symbol]: unknown;
}

export interface FlueHarness {
  readonly name?: string;
  session(name?: string, options?: unknown): Promise<FlueSession>;
  readonly sessions?: FlueSessions;
  [key: string | symbol]: unknown;
}

export interface FlueContext {
  readonly id?: string;
  readonly runId?: string;
  init(options: unknown): Promise<FlueHarness>;
  subscribeEvent?: (callback: (event: FlueEvent) => void) => () => void;
  [key: string | symbol]: unknown;
}

export interface FlueBaseEvent {
  type?: string;
  runId?: string;
  eventIndex?: number;
  timestamp?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  harness?: string;
  operationId?: string;
  [key: string]: unknown;
}

export interface FlueOperationStartEvent extends FlueBaseEvent {
  type: "operation_start";
  operationId: string;
  operationKind: FlueOperationKind | "shell";
}

export interface FlueOperationEvent extends FlueBaseEvent {
  type: "operation";
  operationId: string;
  operationKind: FlueOperationKind | "shell";
  durationMs?: number;
  isError?: boolean;
  error?: unknown;
  result?: unknown;
  usage?: FlueUsage;
}

export interface FlueTurnEvent extends FlueBaseEvent {
  type: "turn";
  durationMs?: number;
  model?: string;
  usage?: FlueUsage;
  stopReason?: string;
  isError?: boolean;
  error?: unknown;
}

export interface FlueThinkingDeltaEvent extends FlueBaseEvent {
  type: "thinking_delta";
  delta?: string;
}

export interface FlueThinkingEndEvent extends FlueBaseEvent {
  type: "thinking_end";
  content?: string;
}

export interface FlueToolStartEvent extends FlueBaseEvent {
  type: "tool_start";
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
}

export interface FlueToolCallEvent extends FlueBaseEvent {
  type: "tool_call";
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  result?: unknown;
  durationMs?: number;
}

export interface FlueTaskStartEvent extends FlueBaseEvent {
  type: "task_start";
  taskId: string;
  prompt?: string;
  role?: string;
  cwd?: string;
}

export interface FlueTaskEvent extends FlueBaseEvent {
  type: "task";
  taskId: string;
  isError?: boolean;
  result?: unknown;
  durationMs?: number;
}

export interface FlueCompactionStartEvent extends FlueBaseEvent {
  type: "compaction_start";
  reason?: "threshold" | "overflow" | "manual";
  estimatedTokens?: number;
}

export interface FlueCompactionEvent extends FlueBaseEvent {
  type: "compaction";
  messagesBefore?: number;
  messagesAfter?: number;
  durationMs?: number;
  usage?: FlueUsage;
}

export type FlueEvent =
  | FlueOperationStartEvent
  | FlueOperationEvent
  | FlueThinkingDeltaEvent
  | FlueThinkingEndEvent
  | FlueTurnEvent
  | FlueToolStartEvent
  | FlueToolCallEvent
  | FlueTaskStartEvent
  | FlueTaskEvent
  | FlueCompactionStartEvent
  | FlueCompactionEvent
  | FlueBaseEvent;
