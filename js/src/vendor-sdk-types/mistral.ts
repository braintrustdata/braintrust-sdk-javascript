export type MistralToolCallDelta = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  [key: string]: unknown;
};

export type MistralChatMessageDelta = {
  role?: string;
  content?: string | null;
  toolCalls?: MistralToolCallDelta[] | null;
  tool_calls?: MistralToolCallDelta[] | null;
  [key: string]: unknown;
};

export type MistralChatCompletionChoice = {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    toolCalls?: unknown;
    tool_calls?: unknown;
  };
  finishReason?: string | null;
  finish_reason?: string | null;
  [key: string]: unknown;
};

export type MistralChatCompletionChunkChoice = {
  index?: number;
  delta?: MistralChatMessageDelta;
  finishReason?: string | null;
  finish_reason?: string | null;
  [key: string]: unknown;
};

export type MistralChatCompletionChunk = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  usage?: unknown;
  choices?: MistralChatCompletionChunkChoice[];
  [key: string]: unknown;
};

export type MistralChatCompletionEvent = {
  data?: MistralChatCompletionChunk;
  [key: string]: unknown;
};

export type MistralChatCompletionResponse = {
  id?: string;
  object?: string;
  model?: string;
  created?: number;
  usage?: unknown;
  choices?: MistralChatCompletionChoice[];
  [key: string]: unknown;
};

export type MistralEmbeddingCreateParams = {
  inputs?: unknown;
  [key: string]: unknown;
};

export type MistralFimCreateParams = {
  prompt?: unknown;
  suffix?: unknown;
  stream?: boolean;
  [key: string]: unknown;
};

export type MistralAgentsCreateParams = {
  messages?: unknown;
  agentId?: string;
  agent_id?: string;
  stream?: boolean;
  [key: string]: unknown;
};

export type MistralEmbeddingResponse = {
  id?: string;
  object?: string;
  model?: string;
  usage?: unknown;
  data?: Array<{
    embedding?: number[] | string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type MistralChatCreateParams = {
  messages?: unknown;
  stream?: boolean;
  [key: string]: unknown;
};

export type MistralChatStreamingResult =
  AsyncIterable<MistralChatCompletionEvent>;
export type MistralFimStreamingResult =
  AsyncIterable<MistralChatCompletionEvent>;
export type MistralAgentsStreamingResult =
  AsyncIterable<MistralChatCompletionEvent>;

export type MistralFimCompletionResponse = MistralChatCompletionResponse;
export type MistralAgentsCompletionResponse = MistralChatCompletionResponse;
export type MistralFimCompletionEvent = MistralChatCompletionEvent;
export type MistralAgentsCompletionEvent = MistralChatCompletionEvent;

export type MistralChatResult =
  | MistralChatCompletionResponse
  | MistralChatStreamingResult;
export type MistralFimResult =
  | MistralFimCompletionResponse
  | MistralFimStreamingResult;
export type MistralAgentsResult =
  | MistralAgentsCompletionResponse
  | MistralAgentsStreamingResult;

export type MistralChat = {
  complete: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatCompletionResponse>;
  stream: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatStreamingResult>;
};

export type MistralEmbeddings = {
  create: (
    request: MistralEmbeddingCreateParams,
    options?: unknown,
  ) => Promise<MistralEmbeddingResponse>;
};

export type MistralFim = {
  complete: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimCompletionResponse>;
  stream: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimStreamingResult>;
};

export type MistralAgents = {
  complete: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsCompletionResponse>;
  stream: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsStreamingResult>;
};

export type MistralClient = {
  chat?: MistralChat;
  fim?: MistralFim;
  agents?: MistralAgents;
  embeddings?: MistralEmbeddings;
  [key: string]: unknown;
};
