/**
 * Narrow AI SDK v7 telemetry types used by Braintrust.
 *
 * These mirror only the callback fields Braintrust reads. The public AI SDK
 * `Telemetry` type is structural, so users do not need `ai` installed as a
 * direct dependency for this package to type-check.
 */

export interface AISDKV7TelemetryOptions {
  recordInputs?: boolean;
  recordOutputs?: boolean;
  functionId?: string;
}

export const BRAINTRUST_AI_SDK_V7_OPERATION_KEY = Symbol.for(
  "braintrust.ai-sdk.v7.telemetry-operation-key",
);

interface AISDKV7ModelInfo {
  provider?: string;
  modelId?: string;
}

export interface AISDKV7OperationEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  operationId: string;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7LanguageModelCallStartEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7LanguageModelCallEndEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  content?: unknown;
  finishReason?: unknown;
  responseId?: string;
  usage?: unknown;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7ObjectStepStartEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  promptMessages?: unknown;
  stepNumber?: number;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7ObjectStepEndEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  finishReason?: unknown;
  objectText?: string;
  providerMetadata?: unknown;
  reasoning?: unknown;
  request?: unknown;
  response?: unknown;
  usage?: unknown;
  warnings?: unknown;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7EmbedStartEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  embedCallId: string;
  operationId: string;
  values: unknown[];
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7EmbedEndEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  embedCallId: string;
  operationId: string;
  embeddings?: unknown[];
  usage?: unknown;
  values?: unknown[];
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7RerankStartEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  documents?: unknown[];
  query?: string;
  topN?: number;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7RerankEndEvent
  extends AISDKV7TelemetryOptions, AISDKV7ModelInfo {
  callId: string;
  ranking?: Array<{ index?: number; relevanceScore?: number }>;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

interface AISDKV7ToolCall {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface AISDKV7ToolExecutionStartEvent extends AISDKV7TelemetryOptions {
  callId?: string;
  toolCall: AISDKV7ToolCall;
  toolContext?: unknown;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

interface AISDKV7ToolOutput {
  type?: "tool-result" | "tool-error" | string;
  output?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface AISDKV7ToolExecutionEndEvent extends AISDKV7TelemetryOptions {
  callId?: string;
  durationMs?: number;
  error?: unknown;
  output?: unknown;
  success?: boolean;
  toolCall: AISDKV7ToolCall;
  toolOutput?: AISDKV7ToolOutput;
  [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  [key: string]: unknown;
}

export interface AISDKV7ChunkEvent {
  chunk?: {
    type?: string;
    callId?: string;
    [key: string]: unknown;
  };
}

export interface AISDKV7Telemetry {
  onStart?: (event: AISDKV7OperationEvent) => void | PromiseLike<void>;
  onStepStart?: (event: unknown) => void | PromiseLike<void>;
  onLanguageModelCallStart?: (
    event: AISDKV7LanguageModelCallStartEvent,
  ) => void | PromiseLike<void>;
  onLanguageModelCallEnd?: (
    event: AISDKV7LanguageModelCallEndEvent,
  ) => void | PromiseLike<void>;
  onObjectStepStart?: (
    event: AISDKV7ObjectStepStartEvent,
  ) => void | PromiseLike<void>;
  onObjectStepEnd?: (
    event: AISDKV7ObjectStepEndEvent,
  ) => void | PromiseLike<void>;
  onEmbedStart?: (event: AISDKV7EmbedStartEvent) => void | PromiseLike<void>;
  onEmbedEnd?: (event: AISDKV7EmbedEndEvent) => void | PromiseLike<void>;
  onRerankStart?: (event: AISDKV7RerankStartEvent) => void | PromiseLike<void>;
  onRerankEnd?: (event: AISDKV7RerankEndEvent) => void | PromiseLike<void>;
  onToolExecutionStart?: (
    event: AISDKV7ToolExecutionStartEvent,
  ) => void | PromiseLike<void>;
  onToolExecutionEnd?: (
    event: AISDKV7ToolExecutionEndEvent,
  ) => void | PromiseLike<void>;
  onChunk?: (event: AISDKV7ChunkEvent) => void | PromiseLike<void>;
  onStepEnd?: (event: unknown) => void | PromiseLike<void>;
  onStepFinish?: (event: unknown) => void | PromiseLike<void>;
  onEnd?: (event: AISDKV7OperationEvent) => void | PromiseLike<void>;
  onAbort?: (event: unknown) => void | PromiseLike<void>;
  onError?: (event: unknown) => void | PromiseLike<void>;
  executeTool?: <T>(options: {
    callId: string;
    toolCallId: string;
    execute: () => PromiseLike<T>;
    [BRAINTRUST_AI_SDK_V7_OPERATION_KEY]?: string;
  }) => PromiseLike<T>;
}

export type AISDKV7TelemetryDispatcher = AISDKV7Telemetry;

export interface AISDKV7CreateTelemetryDispatcherArgs {
  telemetry?: AISDKV7TelemetryOptions & {
    isEnabled?: boolean;
    integrations?: unknown;
  };
}
