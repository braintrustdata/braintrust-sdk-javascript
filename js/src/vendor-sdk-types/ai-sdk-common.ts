/**
 * Vendored AI SDK types used internally by the wrapper and auto-instrumentation.
 *
 * These are intentionally small and only model the surface Braintrust reads.
 */

export interface AISDKTokenBucket {
  total?: number;
  cacheRead?: number;
  reasoning?: number;
  [key: string]: unknown;
}

type AISDKTokenCount = number & AISDKTokenBucket;

export interface AISDKUsage {
  inputTokens?: AISDKTokenCount;
  outputTokens?: AISDKTokenCount;
  totalTokens?: number;
  tokens?: number;
  total_tokens?: number;
  promptTokens?: number;
  prompt_tokens?: number;
  completionTokens?: number;
  completion_tokens?: number;
  cachedInputTokens?: number;
  promptCachedTokens?: number;
  prompt_cached_tokens?: number;
  promptCacheCreationTokens?: number;
  prompt_cache_creation_tokens?: number;
  promptReasoningTokens?: number;
  prompt_reasoning_tokens?: number;
  completionCachedTokens?: number;
  completion_cached_tokens?: number;
  reasoningTokens?: number;
  completionReasoningTokens?: number;
  completion_reasoning_tokens?: number;
  reasoning_tokens?: number;
  thinkingTokens?: number;
  thinking_tokens?: number;
  completionAudioTokens?: number;
  completion_audio_tokens?: number;
}

export interface AISDKGatewayRouting {
  resolvedProvider?: string;
  finalProvider?: string;
  resolvedProviderApiModelId?: string;
}

export interface AISDKGatewayMetadata {
  routing?: AISDKGatewayRouting;
  cost?: number | string;
  marketCost?: number | string;
}

export interface AISDKProviderMetadata {
  gateway?: AISDKGatewayMetadata;
  [key: string]: unknown;
}

export interface AISDKStepResult {
  providerMetadata?: AISDKProviderMetadata;
  [key: string]: unknown;
}

export interface AISDKGeneratedFile {
  mediaType?: string;
  base64?: string;
  uint8Array?: Uint8Array;
  [key: string]: unknown;
}

export interface AISDKLanguageModel {
  modelId?: string;
  provider?: string;
  supportsStructuredOutputs?: boolean;
  doGenerate?: (options: AISDKCallParams) => Promise<AISDKResult>;
  doStream?: (
    options: AISDKCallParams,
  ) => Promise<AISDKResult & { stream: ReadableStream<AISDKModelStreamChunk> }>;
  _braintrustWrapped?: boolean;
  [key: string]: unknown;
}

export type AISDKModel = string | AISDKLanguageModel;

export interface AISDKOutputResponseFormat {
  type?: unknown;
  schema?: unknown;
  [key: string]: unknown;
}

export interface AISDKSyncOutputObject {
  type?: string;
  responseFormat:
    | AISDKOutputResponseFormat
    | ((args: { model: AISDKLanguageModel }) => AISDKOutputResponseFormat);
  [key: string]: unknown;
}

export interface AISDKAsyncOutputObject {
  type?: string;
  responseFormat:
    | Promise<AISDKOutputResponseFormat>
    | ((args: {
        model: AISDKLanguageModel;
      }) => AISDKOutputResponseFormat | Promise<AISDKOutputResponseFormat>);
  [key: string]: unknown;
}

export type AISDKOutputObject = AISDKSyncOutputObject | AISDKAsyncOutputObject;

export interface AISDKMessage {
  content?: unknown;
  [key: string]: unknown;
}

export interface AISDKModelStreamChunk {
  type: string;
  textDelta?: string;
  delta?: string;
  text?: string;
  content?: string;
  object?: unknown;
  rawValue?: {
    delta?: { content?: string };
    choices?: Array<{ delta?: { content?: string } }>;
    text?: string;
    content?: string;
    [key: string]: unknown;
  };
  finishReason?: string;
  usage?: AISDKUsage;
  [key: string]: unknown;
}

export interface AISDKTool {
  name?: string;
  toolName?: string;
  id?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  execute?: unknown;
  render?: unknown;
  [key: string]: unknown;
  [key: symbol]: unknown;
}

export type AISDKTools = AISDKTool[] | Record<string, AISDKTool>;

export interface AISDKEmbedParams {
  model?: AISDKModel;
  value?: unknown;
  values?: unknown[];
  [key: string]: unknown;
}

export interface AISDKCallParams {
  model?: AISDKModel;
  prompt?: AISDKMessage[] | Record<string, unknown>;
  messages?: AISDKMessage[];
  tools?: AISDKTools;
  schema?: unknown;
  output?: unknown;
  callOptionsSchema?: unknown;
  onChunk?: (chunk: AISDKModelStreamChunk) => unknown;
  onFinish?: (event: AISDKResult) => unknown;
  onError?: (error: unknown) => unknown;
  [key: string]: unknown;
}

type AISDKGeneratedFiles = AISDKGeneratedFile[] & Promise<AISDKGeneratedFile[]>;

export interface AISDKResult {
  usage?: AISDKUsage;
  totalUsage?: AISDKUsage;
  providerMetadata?: AISDKProviderMetadata;
  experimental_providerMetadata?: AISDKProviderMetadata;
  steps?: AISDKStepResult[];
  text?: string;
  object?: unknown;
  finishReason?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  warnings?: unknown[];
  rawResponse?: Record<string, unknown>;
  response?: Record<string, unknown>;
  request?: Record<string, unknown>;
  files?: AISDKGeneratedFiles;
  baseStream?: ReadableStream<unknown>;
  stream?: ReadableStream<AISDKModelStreamChunk>;
  [key: string]: unknown;
}

export interface AISDKEmbeddingResult extends AISDKResult {
  embedding?: number[];
  embeddings?: number[][];
  value?: unknown;
  values?: unknown[];
  responses?: unknown[];
}

export type AISDKEmbedFunction = (
  params: AISDKEmbedParams,
) => Promise<AISDKEmbeddingResult>;

export type AISDKGenerateFunction = (
  params: AISDKCallParams,
) => Promise<AISDKResult>;

export type AISDKStreamFunction = (params: AISDKCallParams) => AISDKResult;

export interface AISDKAgentInstance {
  settings: AISDKCallParams;
  generate: AISDKGenerateFunction;
  stream: AISDKStreamFunction;
  constructor: {
    name: string;
  };
  [key: string]: unknown;
}

export interface AISDKAgentClass {
  new (...args: unknown[]): AISDKAgentInstance;
}

export interface AISDKProviderResolver {
  languageModel?: (modelId: string) => AISDKLanguageModel;
  [key: string]: unknown;
}

export interface AISDKNamespaceBase {
  generateText: AISDKGenerateFunction;
  streamText: AISDKStreamFunction;
  generateObject: AISDKGenerateFunction;
  streamObject: AISDKStreamFunction;
  embed: AISDKEmbedFunction;
  embedMany: AISDKEmbedFunction;
  gateway?: AISDKProviderResolver;
  [key: string]: unknown;
}
