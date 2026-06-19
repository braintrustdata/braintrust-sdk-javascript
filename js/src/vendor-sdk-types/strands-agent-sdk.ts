/**
 * Vendored types for @strands-agents/sdk used by Braintrust instrumentation.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields we read, wrap, or log.
 */

export interface StrandsAgentSDKModule {
  Agent?: StrandsAgentConstructor;
  Graph?: StrandsMultiAgentConstructor;
  Swarm?: StrandsMultiAgentConstructor;
  [key: string]: unknown;
}

export interface StrandsAgentConstructor {
  new (...args: unknown[]): StrandsAgent;
  [key: string | symbol]: unknown;
}

export interface StrandsMultiAgentConstructor {
  new (...args: unknown[]): StrandsMultiAgent;
  [key: string | symbol]: unknown;
}

export interface StrandsAgent {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly model?: StrandsModel;
  readonly messages?: StrandsMessage[];
  invoke(
    args: StrandsInvokeArgs,
    options?: StrandsInvokeOptions,
  ): Promise<StrandsAgentResult>;
  stream(
    args: StrandsInvokeArgs,
    options?: StrandsInvokeOptions,
  ): AsyncGenerator<StrandsAgentStreamEvent, StrandsAgentResult, undefined>;
  [key: string | symbol]: unknown;
}

export interface StrandsMultiAgent {
  readonly id?: string;
  readonly nodes?: ReadonlyMap<string, StrandsNode>;
  invoke(
    input: StrandsMultiAgentInput,
    options?: StrandsMultiAgentInvokeOptions,
  ): Promise<StrandsMultiAgentResult>;
  stream(
    input: StrandsMultiAgentInput,
    options?: StrandsMultiAgentInvokeOptions,
  ): AsyncGenerator<
    StrandsMultiAgentStreamEvent,
    StrandsMultiAgentResult,
    undefined
  >;
  [key: string | symbol]: unknown;
}

export type StrandsInvokeArgs = unknown;
export type StrandsMultiAgentInput = unknown;

export interface StrandsInvokeOptions {
  invocationState?: Record<string, unknown>;
  cancelSignal?: AbortSignal;
  structuredOutputSchema?: unknown;
  [key: string]: unknown;
}

export interface StrandsMultiAgentInvokeOptions {
  invocationState?: Record<string, unknown>;
  cancelSignal?: AbortSignal;
  [key: string]: unknown;
}

export interface StrandsModel {
  readonly modelId?: string;
  readonly stateful?: boolean;
  getConfig?: () => StrandsModelConfig;
  [key: string | symbol]: unknown;
}

export interface StrandsModelConfig {
  modelId?: string;
  model?: string;
  provider?: string;
  api?: string;
  [key: string]: unknown;
}

export interface StrandsMessage {
  role?: string;
  content?: StrandsContentBlock[];
  metadata?: {
    usage?: StrandsUsage;
    metrics?: StrandsModelMetrics;
    custom?: Record<string, unknown>;
  };
  toJSON?: () => unknown;
  [key: string]: unknown;
}

export type StrandsContentBlock = {
  type?: string;
  text?: string;
  toolUse?: StrandsToolUse;
  toolResult?: StrandsToolResult;
  reasoning?: unknown;
  citations?: unknown;
  toJSON?: () => unknown;
  [key: string]: unknown;
};

export interface StrandsToolUse {
  name: string;
  toolUseId: string;
  input: unknown;
  [key: string]: unknown;
}

export interface StrandsToolResult {
  toolUseId: string;
  status: "success" | "error" | string;
  content?: unknown[];
  error?: Error;
  [key: string]: unknown;
}

export interface StrandsAgentResult {
  type?: "agentResult";
  stopReason?: string;
  lastMessage?: StrandsMessage;
  structuredOutput?: unknown;
  metrics?: {
    accumulatedUsage?: StrandsUsage;
    latestUsage?: StrandsUsage;
    projectedContextSize?: number;
    latestContextSize?: number;
    [key: string]: unknown;
  };
  interrupts?: unknown[];
  toJSON?: () => unknown;
  toString?: () => string;
  [key: string]: unknown;
}

export type StrandsAgentStreamEvent =
  | StrandsBeforeModelCallEvent
  | StrandsAfterModelCallEvent
  | StrandsModelStreamUpdateEvent
  | StrandsBeforeToolCallEvent
  | StrandsAfterToolCallEvent
  | StrandsToolStreamUpdateEvent
  | StrandsToolResultEvent
  | StrandsAgentResultEvent
  | { type?: string; [key: string]: unknown };

export interface StrandsBeforeModelCallEvent {
  type: "beforeModelCallEvent";
  agent?: StrandsAgent;
  model?: StrandsModel;
  projectedInputTokens?: number;
  [key: string]: unknown;
}

export interface StrandsAfterModelCallEvent {
  type: "afterModelCallEvent";
  agent?: StrandsAgent;
  model?: StrandsModel;
  stopData?: {
    message?: StrandsMessage;
    stopReason?: string;
    redaction?: unknown;
  };
  error?: Error;
  attemptCount?: number;
  [key: string]: unknown;
}

export interface StrandsModelStreamUpdateEvent {
  type: "modelStreamUpdateEvent";
  event?: {
    type?: string;
    usage?: StrandsUsage;
    metrics?: StrandsModelMetrics;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StrandsBeforeToolCallEvent {
  type: "beforeToolCallEvent";
  agent?: StrandsAgent;
  toolUse?: StrandsToolUse;
  tool?: { name?: string; description?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface StrandsAfterToolCallEvent {
  type: "afterToolCallEvent";
  agent?: StrandsAgent;
  toolUse?: StrandsToolUse;
  tool?: { name?: string; description?: string; [key: string]: unknown };
  result?: StrandsToolResult;
  error?: Error;
  [key: string]: unknown;
}

export interface StrandsToolStreamUpdateEvent {
  type: "toolStreamUpdateEvent";
  event?: unknown;
  [key: string]: unknown;
}

export interface StrandsToolResultEvent {
  type: "toolResultEvent";
  result?: StrandsToolResult;
  [key: string]: unknown;
}

export interface StrandsAgentResultEvent {
  type: "agentResultEvent";
  result?: StrandsAgentResult;
  [key: string]: unknown;
}

export interface StrandsUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  [key: string]: unknown;
}

export interface StrandsModelMetrics {
  latencyMs?: number;
  timeToFirstByteMs?: number;
  [key: string]: unknown;
}

export interface StrandsNode {
  readonly id?: string;
  readonly type?: string;
  readonly agent?: StrandsAgent;
  readonly orchestrator?: StrandsMultiAgent;
  [key: string | symbol]: unknown;
}

export type StrandsMultiAgentStreamEvent =
  | StrandsBeforeNodeCallEvent
  | StrandsAfterNodeCallEvent
  | StrandsNodeResultEvent
  | StrandsMultiAgentHandoffEvent
  | StrandsMultiAgentResultEvent
  | { type?: string; [key: string]: unknown };

export interface StrandsBeforeNodeCallEvent {
  type: "beforeNodeCallEvent";
  orchestrator?: StrandsMultiAgent;
  nodeId?: string;
  state?: unknown;
  [key: string]: unknown;
}

export interface StrandsAfterNodeCallEvent {
  type: "afterNodeCallEvent";
  orchestrator?: StrandsMultiAgent;
  nodeId?: string;
  error?: Error;
  [key: string]: unknown;
}

export interface StrandsNodeResultEvent {
  type: "nodeResultEvent";
  nodeId?: string;
  nodeType?: string;
  result?: StrandsNodeResult;
  [key: string]: unknown;
}

export interface StrandsMultiAgentHandoffEvent {
  type: "multiAgentHandoffEvent";
  source?: string;
  targets?: string[];
  [key: string]: unknown;
}

export interface StrandsMultiAgentResultEvent {
  type: "multiAgentResultEvent";
  result?: StrandsMultiAgentResult;
  [key: string]: unknown;
}

export interface StrandsNodeResult {
  nodeId?: string;
  status?: string;
  duration?: number;
  content?: StrandsContentBlock[];
  error?: Error;
  structuredOutput?: unknown;
  usage?: StrandsUsage;
  toJSON?: () => unknown;
  [key: string]: unknown;
}

export interface StrandsMultiAgentResult {
  type?: "multiAgentResult";
  status?: string;
  results?: StrandsNodeResult[];
  content?: StrandsContentBlock[];
  duration?: number;
  error?: Error;
  usage?: StrandsUsage;
  interrupts?: unknown[];
  toJSON?: () => unknown;
  [key: string]: unknown;
}
