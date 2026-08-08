import type { ChannelSpanInfo } from "../instrumentation/core/types";

export type BedrockAgentRuntimeCommandName =
  | "InvokeAgentCommand"
  | "InvokeInlineAgentCommand"
  | "RetrieveAndGenerateCommand"
  | "RetrieveAndGenerateStreamCommand";

export interface BedrockAgentRuntimeCommandLike {
  input?: unknown;
  constructor?: {
    name?: string;
  };
  [key: string]: unknown;
}

export interface BedrockAgentRuntimeClient {
  send: (
    command: BedrockAgentRuntimeCommandLike,
    optionsOrCb?: unknown,
    cb?: unknown,
  ) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

export interface BedrockAgentRuntimeChannelContext {
  span_info?: ChannelSpanInfo;
}

export interface BedrockAgentRuntimeInvokeAgentRequest {
  agentId?: string;
  agentAliasId?: string;
  sessionId?: string;
  inputText?: string;
  enableTrace?: boolean;
  endSession?: boolean;
  memoryId?: string;
  streamingConfigurations?: unknown;
  sessionState?: unknown;
  [key: string]: unknown;
}

export interface BedrockAgentRuntimeInvokeInlineAgentRequest {
  foundationModel?: string;
  instruction?: string;
  agentName?: string;
  sessionId?: string;
  inputText?: string;
  enableTrace?: boolean;
  endSession?: boolean;
  streamingConfigurations?: unknown;
  inlineSessionState?: unknown;
  [key: string]: unknown;
}

export interface BedrockAgentRuntimeRetrieveAndGenerateRequest {
  input?: {
    text?: string;
    [key: string]: unknown;
  };
  sessionId?: string;
  retrieveAndGenerateConfiguration?: unknown;
  [key: string]: unknown;
}

export interface BedrockAgentRuntimeTracePart {
  sessionId?: string;
  trace?: Record<string, unknown>;
  agentId?: string;
  agentAliasId?: string;
  agentVersion?: string;
  collaboratorName?: string;
  [key: string]: unknown;
}

export interface BedrockAgentRuntimeStreamEvent {
  chunk?: {
    bytes?: unknown;
    attribution?: unknown;
    [key: string]: unknown;
  };
  trace?: BedrockAgentRuntimeTracePart;
  returnControl?: unknown;
  files?: unknown;
  output?: {
    text?: string;
    [key: string]: unknown;
  };
  citation?: unknown;
  guardrail?: {
    action?: string;
    [key: string]: unknown;
  };
  internalServerException?: unknown;
  validationException?: unknown;
  resourceNotFoundException?: unknown;
  serviceQuotaExceededException?: unknown;
  throttlingException?: unknown;
  accessDeniedException?: unknown;
  conflictException?: unknown;
  dependencyFailedException?: unknown;
  badGatewayException?: unknown;
  modelNotReadyException?: unknown;
  [key: string]: unknown;
}

export interface BedrockAgentRuntimeResponse {
  completion?: AsyncIterable<BedrockAgentRuntimeStreamEvent>;
  stream?: AsyncIterable<BedrockAgentRuntimeStreamEvent>;
  contentType?: string;
  sessionId?: string;
  memoryId?: string;
  output?: {
    text?: string;
    [key: string]: unknown;
  };
  citations?: unknown;
  guardrailAction?: string;
  [key: string]: unknown;
}

export type BedrockAgentRuntimeSendResult =
  | BedrockAgentRuntimeResponse
  | unknown;
