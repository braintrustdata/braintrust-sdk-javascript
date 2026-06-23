/**
 * Vendored types for @flue/runtime observe/instrument-based instrumentation.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields we read, correlate, or log.
 */

export type FlueOperationKind = "prompt" | "skill" | "task" | "compact";
export type FlueRuntimeOperationKind = FlueOperationKind | "shell";
export type FlueTurnPurpose = "agent" | "compaction" | "compaction_prefix";

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

export interface FlueBaseEvent {
  type?: string;
  v?: number;
  runId?: string;
  instanceId?: string;
  submissionId?: string;
  dispatchId?: string;
  eventIndex?: number;
  timestamp?: string;
  conversationId?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  harness?: string;
  operationId?: string;
  turnId?: string;
  [key: string]: unknown;
}

export interface FlueRunStartEvent extends FlueBaseEvent {
  type: "run_start";
  runId: string;
  startedAt?: string;
  workflowName?: string;
  owner?: {
    kind?: string;
    workflowName?: string;
    instanceId?: string;
  };
  input?: unknown;
  payload?: unknown;
}

export interface FlueRunResumeEvent extends FlueBaseEvent {
  type: "run_resume";
  runId: string;
  startedAt?: string;
  workflowName?: string;
}

export interface FlueRunEndEvent extends FlueBaseEvent {
  type: "run_end";
  runId: string;
  result?: unknown;
  isError?: boolean;
  error?: unknown;
  durationMs?: number;
}

export interface FlueOperationStartEvent extends FlueBaseEvent {
  type: "operation_start";
  operationId: string;
  operationKind: FlueRuntimeOperationKind;
}

export interface FlueOperationEvent extends FlueBaseEvent {
  type: "operation";
  operationId: string;
  operationKind: FlueRuntimeOperationKind;
  durationMs?: number;
  isError?: boolean;
  error?: unknown;
  result?: unknown;
  usage?: FlueUsage;
}

export interface FlueTurnRequestEvent extends FlueBaseEvent {
  type: "turn_request";
  turnId: string;
  purpose: FlueTurnPurpose;
  model?: string;
  provider?: string;
  api?: string;
  input?: {
    systemPrompt?: string;
    messages?: unknown[];
    tools?: unknown[];
  };
  request?: {
    api?: string;
    input?: {
      systemPrompt?: string;
      messages?: unknown[];
      tools?: unknown[];
    };
    model?: string;
    providerId?: string;
    providerName?: string;
    reasoning?: string;
  };
  reasoning?: string;
}

export interface FlueTurnEvent extends FlueBaseEvent {
  type: "turn";
  turnId: string;
  purpose?: FlueTurnPurpose;
  durationMs?: number;
  model?: string;
  provider?: string;
  api?: string;
  request?: {
    api?: string;
    model?: string;
    providerId?: string;
    providerName?: string;
  };
  response?: {
    output?: unknown;
    usage?: FlueUsage;
    stopReason?: string;
    error?: unknown;
    errorInfo?: { type?: string; message?: string };
  };
  output?: unknown;
  usage?: FlueUsage;
  stopReason?: string;
  isError?: boolean;
  error?: unknown;
}

export interface FlueToolStartEvent extends FlueBaseEvent {
  type: "tool_start";
  toolName?: string;
  toolCallId: string;
  args?: unknown;
  arguments?: unknown;
  input?: unknown;
}

export interface FlueToolCallEvent extends FlueBaseEvent {
  type: "tool_call" | "tool";
  toolName?: string;
  toolCallId: string;
  isError?: boolean;
  result?: unknown;
  output?: unknown;
  error?: unknown;
  errorInfo?: { type?: string; message?: string };
  durationMs?: number;
}

export interface FlueTaskStartEvent extends FlueBaseEvent {
  type: "task_start";
  taskId: string;
  prompt?: string;
  agent?: string;
  cwd?: string;
}

export interface FlueTaskEvent extends FlueBaseEvent {
  type: "task";
  taskId: string;
  agent?: string;
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

export interface FlueContext {
  readonly id?: string;
  readonly runId?: string;
  [key: string | symbol]: unknown;
}

export interface FlueObservableContext extends FlueContext {
  subscribeEvent(callback: (event: unknown) => unknown): () => void;
}

export type FlueExecutionOperation =
  | {
      type: "workflow";
      runId: string;
      workflowName: string;
      phase: "start" | "resume";
      startedAt: string;
    }
  | { type: "agent"; operationId: string; operationKind: FlueOperationKind }
  | { type: "model"; turnId: string }
  | { type: "tool"; toolCallId: string; toolName: string }
  | { type: "task"; taskId: string };

export interface FlueTraceCarrier {
  traceparent: string;
  tracestate?: string;
}

export interface FlueExecutionContext {
  eventContext?: FlueContext;
  runId?: string;
  instanceId?: string;
  submissionId?: string;
  dispatchId?: string;
  agentName?: string;
  conversationId?: string;
  harness?: string;
  session?: string;
  operationId?: string;
  turnId?: string;
  taskId?: string;
  traceCarrier?: FlueTraceCarrier;
}

export type FlueExecutionInterceptor = <T>(
  operation: FlueExecutionOperation,
  ctx: FlueExecutionContext,
  next: () => Promise<T>,
) => Promise<T>;

export interface FlueInstrumentation {
  key?: symbol;
  observe(event: unknown, ctx?: unknown): void | Promise<void>;
  interceptor: FlueExecutionInterceptor;
  dispose(): void | Promise<void>;
}

export type FlueEvent =
  | FlueRunStartEvent
  | FlueRunResumeEvent
  | FlueRunEndEvent
  | FlueOperationStartEvent
  | FlueOperationEvent
  | FlueTurnRequestEvent
  | FlueTurnEvent
  | FlueToolStartEvent
  | FlueToolCallEvent
  | FlueTaskStartEvent
  | FlueTaskEvent
  | FlueCompactionStartEvent
  | FlueCompactionEvent;
