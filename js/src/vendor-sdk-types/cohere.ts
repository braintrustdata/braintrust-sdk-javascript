export type CohereTokenUsage = {
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  reasoningTokens?: number;
  reasoning_tokens?: number;
  thinkingTokens?: number;
  thinking_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
};

export type CohereBilledUnits = {
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  searchUnits?: number;
  search_units?: number;
  classifications?: number;
  images?: number;
  imageTokens?: number;
  image_tokens?: number;
  [key: string]: unknown;
};

export type CohereUsageLike = {
  tokens?: CohereTokenUsage;
  billedUnits?: CohereBilledUnits;
  billed_units?: CohereBilledUnits;
  cachedTokens?: number;
  cached_tokens?: number;
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
};

export type CohereMetaLike = CohereUsageLike & {
  apiVersion?: unknown;
  api_version?: unknown;
  warnings?: unknown;
};

export type CohereToolCall = {
  id?: string;
  index?: number;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  name?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
};

export type CohereChatResponse = {
  id?: string;
  generationId?: string;
  generation_id?: string;
  responseId?: string;
  response_id?: string;
  text?: string;
  finishReason?: string;
  finish_reason?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolPlan?: string;
    tool_plan?: string;
    toolCalls?: CohereToolCall[];
    tool_calls?: CohereToolCall[];
    [key: string]: unknown;
  };
  toolCalls?: CohereToolCall[];
  tool_calls?: CohereToolCall[];
  usage?: CohereUsageLike;
  meta?: CohereMetaLike;
  [key: string]: unknown;
};

export type CohereChatStreamEvent = {
  eventType?: string;
  event_type?: string;
  type?: string;
  id?: string;
  index?: number;
  text?: string;
  toolCalls?: CohereToolCall[];
  tool_calls?: CohereToolCall[];
  response?: CohereChatResponse;
  delta?: {
    error?: string;
    finishReason?: string;
    finish_reason?: string;
    usage?: CohereUsageLike;
    message?: {
      role?: string;
      toolPlan?: string;
      tool_plan?: string;
      content?:
        | string
        | {
            type?: "text" | "thinking";
            thinking?: string;
            text?: string;
            [key: string]: unknown;
          }
        | null;
      toolCalls?: CohereToolCall | CohereToolCall[] | null;
      tool_calls?: CohereToolCall | CohereToolCall[] | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type CohereChatRequest = {
  model?: string;
  message?: unknown;
  messages?: unknown;
  [key: string]: unknown;
};

export type CohereEmbedRequest = {
  model?: string;
  inputType?: string;
  input_type?: string;
  texts?: unknown;
  images?: unknown;
  inputs?: unknown;
  [key: string]: unknown;
};

export type CohereEmbedResponse = {
  id?: string;
  responseType?: string;
  response_type?: string;
  embeddings?: unknown;
  usage?: CohereUsageLike;
  meta?: CohereMetaLike;
  [key: string]: unknown;
};

export type CohereRerankRequest = {
  model?: string;
  query?: string;
  documents?: unknown;
  [key: string]: unknown;
};

export type CohereRerankResponse = {
  id?: string;
  results?: Array<{
    index?: number;
    relevanceScore?: number;
    relevance_score?: number;
    [key: string]: unknown;
  }>;
  usage?: CohereUsageLike;
  meta?: CohereMetaLike;
  [key: string]: unknown;
};

export type CohereChatStreamResult = AsyncIterable<CohereChatStreamEvent>;

export type CohereClient = {
  chat?: (
    request: CohereChatRequest,
    options?: unknown,
  ) => Promise<CohereChatResponse>;
  chatStream?: (
    request: CohereChatRequest,
    options?: unknown,
  ) => Promise<CohereChatStreamResult>;
  embed?: (
    request: CohereEmbedRequest,
    options?: unknown,
  ) => Promise<CohereEmbedResponse>;
  rerank?: (
    request: CohereRerankRequest,
    options?: unknown,
  ) => Promise<CohereRerankResponse>;
  [key: string]: unknown;
};
