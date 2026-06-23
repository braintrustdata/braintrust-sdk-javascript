import type { ChannelSpanInfo } from "../instrumentation/core/types";

export type BedrockRuntimeCommandName =
  | "ConverseCommand"
  | "ConverseStreamCommand"
  | "InvokeModelCommand"
  | "InvokeModelWithResponseStreamCommand";

export interface BedrockRuntimeCommandLike {
  input?: unknown;
  constructor?: {
    name?: string;
  };
  [key: string]: unknown;
}

export interface BedrockRuntimeClient {
  send: (
    command: BedrockRuntimeCommandLike,
    optionsOrCb?: unknown,
    cb?: unknown,
  ) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

export interface BedrockRuntimeChannelContext {
  span_info?: ChannelSpanInfo;
}

export interface BedrockRuntimeContentBlock {
  text?: string;
  image?: unknown;
  document?: unknown;
  toolUse?: unknown;
  toolResult?: unknown;
  reasoningContent?: unknown;
  [key: string]: unknown;
}

export interface BedrockRuntimeMessage {
  role?: string;
  content?: BedrockRuntimeContentBlock[];
  [key: string]: unknown;
}

export interface BedrockRuntimeConverseRequest {
  modelId?: string;
  messages?: BedrockRuntimeMessage[];
  system?: BedrockRuntimeContentBlock[];
  inferenceConfig?: Record<string, unknown>;
  toolConfig?: unknown;
  guardrailConfig?: unknown;
  additionalModelRequestFields?: unknown;
  additionalModelResponseFieldPaths?: unknown;
  requestMetadata?: unknown;
  performanceConfig?: unknown;
  serviceTier?: string;
  outputConfig?: unknown;
  [key: string]: unknown;
}

export interface BedrockRuntimeTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheReadInputTokenCount?: number;
  cacheWriteInputTokenCount?: number;
  [key: string]: unknown;
}

export interface BedrockRuntimeConverseMetrics {
  latencyMs?: number;
  [key: string]: unknown;
}

export interface BedrockRuntimeConverseResponse {
  output?: {
    message?: BedrockRuntimeMessage;
    [key: string]: unknown;
  };
  stopReason?: string;
  usage?: BedrockRuntimeTokenUsage;
  metrics?: BedrockRuntimeConverseMetrics;
  additionalModelResponseFields?: unknown;
  performanceConfig?: unknown;
  serviceTier?: string;
  [key: string]: unknown;
}

export interface BedrockRuntimeConverseStreamResponse {
  stream?: AsyncIterable<BedrockRuntimeConverseStreamEvent>;
  [key: string]: unknown;
}

export interface BedrockRuntimeStreamException {
  name?: string;
  message?: string;
  $fault?: string;
  originalMessage?: string;
  originalStatusCode?: number;
  [key: string]: unknown;
}

export interface BedrockRuntimeConverseStreamEvent {
  messageStart?: {
    role?: string;
    [key: string]: unknown;
  };
  contentBlockStart?: {
    contentBlockIndex?: number;
    start?: BedrockRuntimeContentBlock;
    [key: string]: unknown;
  };
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: BedrockRuntimeContentBlock;
    [key: string]: unknown;
  };
  contentBlockStop?: {
    contentBlockIndex?: number;
    [key: string]: unknown;
  };
  messageStop?: {
    stopReason?: string;
    additionalModelResponseFields?: unknown;
    [key: string]: unknown;
  };
  metadata?: {
    usage?: BedrockRuntimeTokenUsage;
    metrics?: BedrockRuntimeConverseMetrics;
    trace?: unknown;
    performanceConfig?: unknown;
    serviceTier?: string;
    [key: string]: unknown;
  };
  internalServerException?: BedrockRuntimeStreamException;
  modelStreamErrorException?: BedrockRuntimeStreamException;
  validationException?: BedrockRuntimeStreamException;
  throttlingException?: BedrockRuntimeStreamException;
  serviceUnavailableException?: BedrockRuntimeStreamException;
  [key: string]: unknown;
}

export interface BedrockRuntimeInvokeModelRequest {
  modelId?: string;
  body?: unknown;
  contentType?: string;
  accept?: string;
  trace?: string;
  guardrailIdentifier?: string;
  guardrailVersion?: string;
  performanceConfigLatency?: string;
  serviceTier?: string;
  [key: string]: unknown;
}

export interface BedrockRuntimeInvokeModelResponse {
  body?: unknown;
  contentType?: string;
  performanceConfigLatency?: string;
  serviceTier?: string;
  [key: string]: unknown;
}

export interface BedrockRuntimeInvokeModelWithResponseStreamResponse {
  body?: AsyncIterable<BedrockRuntimeResponseStreamEvent>;
  contentType?: string;
  performanceConfigLatency?: string;
  serviceTier?: string;
  [key: string]: unknown;
}

export interface BedrockRuntimeResponseStreamEvent {
  chunk?: {
    bytes?: unknown;
    [key: string]: unknown;
  };
  internalServerException?: BedrockRuntimeStreamException;
  modelStreamErrorException?: BedrockRuntimeStreamException;
  validationException?: BedrockRuntimeStreamException;
  throttlingException?: BedrockRuntimeStreamException;
  modelTimeoutException?: BedrockRuntimeStreamException;
  serviceUnavailableException?: BedrockRuntimeStreamException;
  [key: string]: unknown;
}

export type BedrockRuntimeSendResult =
  | BedrockRuntimeConverseResponse
  | BedrockRuntimeConverseStreamResponse
  | BedrockRuntimeInvokeModelResponse
  | BedrockRuntimeInvokeModelWithResponseStreamResponse
  | unknown;
