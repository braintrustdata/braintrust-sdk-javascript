// @openrouter/agent types

export type OpenRouterAgentChatToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type OpenRouterAgentChatChoice = {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: unknown;
  };
  logprobs?: unknown;
  finish_reason?: string | null;
};

export type OpenRouterAgentChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: OpenRouterAgentChatToolCallDelta[];
      toolCalls?: OpenRouterAgentChatToolCallDelta[];
      finish_reason?: string | null;
      finishReason?: string | null;
    };
    finish_reason?: string | null;
    finishReason?: string | null;
  }>;
  usage?: unknown;
  [key: string]: unknown;
};

export type OpenRouterAgentEmbeddingResponse =
  | string
  | {
      data?: Array<{
        embedding?: number[] | string;
      }>;
      usage?: unknown;
      [key: string]: unknown;
    };

export type OpenRouterAgentResponse = {
  output?: unknown;
  usage?: unknown;
  [key: string]: unknown;
};

export type OpenRouterAgentResponseStreamEvent = {
  type?: string;
  response?: OpenRouterAgentResponse;
  [key: string]: unknown;
};

export type OpenRouterAgentToolTurnContext = {
  toolCall?: {
    id?: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterAgentTool = {
  function?: {
    name?: string;
    execute?: (...args: unknown[]) => unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenRouterAgentCallModelRequest = {
  input?: unknown;
  model?: unknown;
  tools?: readonly OpenRouterAgentTool[];
  [key: string]: unknown;
};

export type OpenRouterAgentCallModelArgs = [OpenRouterAgentCallModelRequest];

export type OpenRouterAgentClient = {
  callModel?: (
    request: OpenRouterAgentCallModelRequest,
    options?: unknown,
  ) => unknown;
  [key: string]: unknown;
};
