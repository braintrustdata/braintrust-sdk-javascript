// ollama types

export interface OllamaOptions {
  num_predict?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
}

export interface OllamaToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

export interface OllamaTool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role?: string;
  content?: string;
  thinking?: string;
  images?: unknown[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaChatRequest {
  model: string;
  messages?: OllamaMessage[];
  stream?: boolean;
  format?: string | Record<string, unknown>;
  tools?: OllamaTool[];
  options?: OllamaOptions;
}

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  suffix?: string;
  system?: string;
  stream?: boolean;
  format?: string | Record<string, unknown>;
  images?: unknown[];
  options?: OllamaOptions;
}

export interface OllamaEmbedRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
  options?: OllamaOptions;
}

export interface OllamaEmbeddingsRequest {
  model: string;
  prompt: string;
  options?: OllamaOptions;
}

export interface OllamaUsageResponse {
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaChatResponse extends OllamaUsageResponse {
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
}

export interface OllamaGenerateResponse extends OllamaUsageResponse {
  response?: string;
  thinking?: string;
  done?: boolean;
  done_reason?: string;
}

export interface OllamaEmbedResponse extends OllamaUsageResponse {
  embeddings?: number[][];
}

export interface OllamaEmbeddingsResponse {
  embedding?: number[];
}

export interface OllamaAsyncIterator<T> extends AsyncIterable<T> {
  abort?: () => void;
}

export type OllamaChatResult =
  | OllamaChatResponse
  | OllamaAsyncIterator<OllamaChatResponse>;

export type OllamaGenerateResult =
  | OllamaGenerateResponse
  | OllamaAsyncIterator<OllamaGenerateResponse>;

export interface OllamaClient {
  chat?: (request: OllamaChatRequest) => Promise<OllamaChatResult>;
  generate?: (request: OllamaGenerateRequest) => Promise<OllamaGenerateResult>;
  embed?: (request: OllamaEmbedRequest) => Promise<OllamaEmbedResponse>;
  embeddings?: (
    request: OllamaEmbeddingsRequest,
  ) => Promise<OllamaEmbeddingsResponse>;
}
