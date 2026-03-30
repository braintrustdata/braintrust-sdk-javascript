export type OpenRouterChatCreateParams = {
  httpReferer?: string;
  xTitle?: string;
  chatGenerationParams?: {
    messages?: unknown;
    stream?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterChatToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type OpenRouterChatChoice = {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: unknown;
  };
  logprobs?: unknown;
  finish_reason?: string | null;
};

export type OpenRouterChatCompletion = {
  choices?: OpenRouterChatChoice[];
  usage?: unknown;
  [key: string]: unknown;
};

export type OpenRouterChatResult =
  | OpenRouterChatCompletion
  | AsyncIterable<OpenRouterChatCompletionChunk>;

export type OpenRouterChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: OpenRouterChatToolCallDelta[];
      toolCalls?: OpenRouterChatToolCallDelta[];
      finish_reason?: string | null;
      finishReason?: string | null;
    };
    finish_reason?: string | null;
    finishReason?: string | null;
  }>;
  usage?: unknown;
  [key: string]: unknown;
};

export type OpenRouterEmbeddingCreateParams = {
  httpReferer?: string;
  xTitle?: string;
  requestBody?: {
    input?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterEmbeddingResponse =
  | string
  | {
      data?: Array<{
        embedding?: number[] | string;
      }>;
      usage?: unknown;
      [key: string]: unknown;
    };

export type OpenRouterResponsesCreateParams = {
  httpReferer?: string;
  xTitle?: string;
  openResponsesRequest?: {
    input?: unknown;
    stream?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterResponse = {
  output?: unknown;
  usage?: unknown;
  [key: string]: unknown;
};

export type OpenRouterResponsesResult =
  | OpenRouterResponse
  | AsyncIterable<OpenRouterResponseStreamEvent>;

export type OpenRouterResponseStreamEvent = {
  type?: string;
  response?: OpenRouterResponse;
  [key: string]: unknown;
};

export type OpenRouterChat = {
  send: (
    request: OpenRouterChatCreateParams,
    options?: unknown,
  ) => Promise<OpenRouterChatResult>;
};

export type OpenRouterEmbeddings = {
  generate: (
    request: OpenRouterEmbeddingCreateParams,
    options?: unknown,
  ) => Promise<OpenRouterEmbeddingResponse>;
};

export type OpenRouterResponses = {
  send: (
    request: OpenRouterResponsesCreateParams,
    options?: unknown,
  ) => Promise<OpenRouterResponsesResult>;
};

export type OpenRouterBeta = {
  responses?: OpenRouterResponses;
};

export type OpenRouterToolTurnContext = {
  toolCall?: {
    id?: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterTool = {
  function?: {
    name?: string;
    execute?: (...args: unknown[]) => unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterCallModelRequest = {
  tools?: readonly OpenRouterTool[];
  [key: string]: unknown;
};

export type OpenRouterClient = {
  chat?: OpenRouterChat;
  embeddings?: OpenRouterEmbeddings;
  beta?: OpenRouterBeta;
  callModel?: (
    request: OpenRouterCallModelRequest,
    options?: unknown,
  ) => unknown;
  [key: string]: unknown;
};
