/**
 * Vendored types for the OpenAI SDK which our wrapper and instrumentation consume.
 *
 * Should never be exposed to users of the SDK!
 */

// Promises

export interface OpenAIAPIPromise<T> extends Promise<T> {
  withResponse(): Promise<OpenAIWithResponse<T>>;
}

export interface OpenAIWithResponse<T> {
  data: T;
  response: Response;
}

// Requests

export interface OpenAIChatCreateParams {
  messages: unknown;
  stream?: boolean | null;
  [key: string]: unknown;
}

export interface OpenAIEmbeddingCreateParams {
  input: unknown;
  [key: string]: unknown;
}

export interface OpenAIModerationCreateParams {
  input: unknown;
  [key: string]: unknown;
}

export interface OpenAIResponseCreateParams {
  input?: unknown;
  stream?: boolean | null;
  [key: string]: unknown;
}

export interface OpenAIResponseCompactParams {
  input: unknown;
  [key: string]: unknown;
}

// Responses

export interface OpenAIUsage {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
  input_tokens_details?: Record<string, number>;
  output_tokens_details?: Record<string, number>;
  [key: string]: number | Record<string, number> | undefined;
}

export interface OpenAIChatToolFunction {
  arguments: string;
  name?: string;
  [key: string]: unknown;
}

export interface OpenAIChatToolCall {
  id?: string;
  type?: string;
  function: OpenAIChatToolFunction;
  [key: string]: unknown;
}

export interface OpenAIChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: OpenAIChatToolCall[];
  [key: string]: unknown;
}

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason?: string | null;
  logprobs?: unknown;
  [key: string]: unknown;
}

export interface OpenAIChatCompletion {
  choices: OpenAIChatChoice[];
  usage?: OpenAIUsage;
  [key: string]: unknown;
}

export interface OpenAIChatDelta {
  role?: string;
  content?: string;
  tool_calls?: OpenAIChatToolCall[];
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface OpenAIChatChunkChoice {
  delta?: OpenAIChatDelta;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface OpenAIChatCompletionChunk {
  choices?: OpenAIChatChunkChoice[];
  usage?: OpenAIUsage;
  [key: string]: unknown;
}

export type OpenAIChatStream = AsyncIterable<OpenAIChatCompletionChunk>;

export interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
    [key: string]: unknown;
  }>;
  usage?: OpenAIUsage;
  [key: string]: unknown;
}

export interface OpenAIModerationResponse {
  results?: unknown[];
  usage?: OpenAIUsage;
  [key: string]: unknown;
}

export interface OpenAIResponse {
  output?: unknown;
  usage?: OpenAIUsage;
  [key: string]: unknown;
}

export interface OpenAIResponseCompletedEvent {
  type: "response.completed";
  response: OpenAIResponse;
}

export type OpenAIResponseStreamEvent =
  | OpenAIResponseCompletedEvent
  | {
      type: string;
      response?: OpenAIResponse;
      [key: string]: unknown;
    };

export type OpenAIResponseStream = AsyncIterable<OpenAIResponseStreamEvent>;

export interface OpenAISyncStream {
  [key: string]: unknown;
}

// Resources

export interface OpenAIChatCompletions {
  create: (
    params: OpenAIChatCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIChatCompletion | OpenAIChatStream>;
  parse?: (
    params: OpenAIChatCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIChatCompletion>;
  stream?: (
    params: OpenAIChatCreateParams,
    options?: unknown,
  ) => OpenAISyncStream;
}

export interface OpenAIChatCompletionsWithParsing extends OpenAIChatCompletions {
  parse: (
    params: OpenAIChatCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIChatCompletion>;
  stream: (
    params: OpenAIChatCreateParams,
    options?: unknown,
  ) => OpenAISyncStream;
}

export interface OpenAIChat {
  completions: OpenAIChatCompletions;
}

export interface OpenAIChatWithParsing {
  completions: OpenAIChatCompletionsWithParsing;
}

export interface OpenAIBeta {
  chat: OpenAIChatWithParsing;
}

export interface OpenAIEmbeddings {
  create: (
    params: OpenAIEmbeddingCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIEmbeddingResponse>;
}

export interface OpenAIModerations {
  create: (
    params: OpenAIModerationCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIModerationResponse>;
}

export interface OpenAIResponses {
  create: (
    params: OpenAIResponseCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIResponse | OpenAIResponseStream>;
  compact?: (
    params: OpenAIResponseCompactParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIResponse>;
  parse?: (
    params: OpenAIResponseCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIResponse>;
  stream?: (
    params: OpenAIResponseCreateParams,
    options?: unknown,
  ) => OpenAISyncStream;
}

export interface OpenAIResponsesWithParsing extends OpenAIResponses {
  parse: (
    params: OpenAIResponseCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<OpenAIResponse>;
  stream: (
    params: OpenAIResponseCreateParams,
    options?: unknown,
  ) => OpenAISyncStream;
}
