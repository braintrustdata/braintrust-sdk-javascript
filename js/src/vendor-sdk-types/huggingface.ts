export interface HuggingFaceRequestOptions {
  retry_on_error?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  includeCredentials?: string | boolean;
  billTo?: string;
  [key: string]: unknown;
}

export interface HuggingFaceClientConstructor {
  new (...args: unknown[]): HuggingFaceClient;
}

export interface HuggingFaceModule {
  InferenceClient?: HuggingFaceClientConstructor;
  InferenceClientEndpoint?: HuggingFaceClientConstructor;
  HfInference?: HuggingFaceClientConstructor;
  HfInferenceEndpoint?: HuggingFaceClientConstructor;
  chatCompletion?: (
    params: HuggingFaceChatCompletionParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceChatCompletion>;
  chatCompletionStream?: (
    params: HuggingFaceChatCompletionParams,
    options?: HuggingFaceRequestOptions,
  ) => AsyncIterable<HuggingFaceChatCompletionChunk>;
  textGeneration?: (
    params: HuggingFaceTextGenerationParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceTextGenerationOutput>;
  textGenerationStream?: (
    params: HuggingFaceTextGenerationParams,
    options?: HuggingFaceRequestOptions,
  ) => AsyncIterable<HuggingFaceTextGenerationStreamOutput>;
  featureExtraction?: (
    params: HuggingFaceFeatureExtractionParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceFeatureExtractionOutput>;
  [key: string]: unknown;
}

export interface HuggingFaceClient {
  chatCompletion: (
    params: HuggingFaceChatCompletionParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceChatCompletion>;
  chatCompletionStream: (
    params: HuggingFaceChatCompletionParams,
    options?: HuggingFaceRequestOptions,
  ) => AsyncIterable<HuggingFaceChatCompletionChunk>;
  textGeneration: (
    params: HuggingFaceTextGenerationParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceTextGenerationOutput>;
  textGenerationStream: (
    params: HuggingFaceTextGenerationParams,
    options?: HuggingFaceRequestOptions,
  ) => AsyncIterable<HuggingFaceTextGenerationStreamOutput>;
  featureExtraction: (
    params: HuggingFaceFeatureExtractionParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceFeatureExtractionOutput>;
  endpoint?: (endpointUrl: string) => HuggingFaceClient;
  [key: string]: unknown;
}

export interface HuggingFaceChatCompletionParams {
  messages?: unknown;
  model?: string;
  provider?: string;
  endpointUrl?: string;
  stream?: boolean;
  [key: string]: unknown;
}

export interface HuggingFaceTextGenerationParams {
  inputs?: unknown;
  model?: string;
  provider?: string;
  endpointUrl?: string;
  stream?: boolean;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HuggingFaceFeatureExtractionParams {
  inputs?: unknown;
  model?: string;
  provider?: string;
  endpointUrl?: string;
  dimensions?: number | null;
  encoding_format?: "float" | "base64";
  [key: string]: unknown;
}

export interface HuggingFaceUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface HuggingFaceChatMessage {
  role?: string;
  content?: string | null | unknown[];
  tool_calls?: unknown;
  [key: string]: unknown;
}

export interface HuggingFaceChatCompletionChoice {
  index?: number;
  message?: HuggingFaceChatMessage;
  delta?: HuggingFaceChatMessage;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface HuggingFaceChatCompletion {
  id?: string;
  object?: string;
  model?: string;
  created?: number;
  usage?: HuggingFaceUsage;
  choices?: HuggingFaceChatCompletionChoice[];
  [key: string]: unknown;
}

export type HuggingFaceChatCompletionChunk = HuggingFaceChatCompletion;

export interface HuggingFaceTextGenerationToken {
  id?: number;
  text?: string;
  logprob?: number;
  special?: boolean;
  [key: string]: unknown;
}

export interface HuggingFaceTextGenerationDetails {
  finish_reason?: string | null;
  generated_tokens?: number;
  prefill?: HuggingFaceTextGenerationToken[];
  tokens?: HuggingFaceTextGenerationToken[];
  [key: string]: unknown;
}

export interface HuggingFaceTextGenerationOutput {
  generated_text?: string | null;
  details?: HuggingFaceTextGenerationDetails | null;
  [key: string]: unknown;
}

export interface HuggingFaceTextGenerationChoice {
  index?: number;
  text?: string;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface HuggingFaceTextGenerationStreamOutput {
  index?: number;
  token?: HuggingFaceTextGenerationToken;
  choices?: HuggingFaceTextGenerationChoice[];
  generated_text?: string | null;
  details?: HuggingFaceTextGenerationDetails | null;
  usage?: HuggingFaceUsage;
  model?: string;
  object?: string;
  created?: number;
  [key: string]: unknown;
}

export type HuggingFaceFeatureExtractionOutput =
  | number[]
  | number[][]
  | number[][][];
