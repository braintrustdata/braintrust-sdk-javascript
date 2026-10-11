import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatCreateParams,
  OpenAIChatStream,
} from "./openai";

// Only the OpenAI-compatible portion of Portkey consumed by instrumentation.
export type PortkeyChatCreateParams = OpenAIChatCreateParams;
export type PortkeyChatCompletion = OpenAIChatCompletion;
export type PortkeyChatCompletionChunk = OpenAIChatCompletionChunk;
export type PortkeyChatStream = OpenAIChatStream;

export interface PortkeyClient {
  chat: {
    completions: {
      create(
        body: PortkeyChatCreateParams,
        params?: unknown,
        options?: unknown,
      ): Promise<PortkeyChatCompletion | PortkeyChatStream>;
    };
  };
}
