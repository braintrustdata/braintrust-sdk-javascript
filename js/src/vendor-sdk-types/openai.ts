import type {
  OpenAIChatChoice,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatLogprobs,
  OpenAIChatCreateParams,
  OpenAIChatStream,
  OpenAIEmbeddingCreateParams,
  OpenAIEmbeddingResponse,
  OpenAIModerationCreateParams,
  OpenAIModerationResponse,
  OpenAIResponse,
  OpenAIResponseCompactParams,
  OpenAIResponseCompletedEvent,
  OpenAIResponseCreateParams,
  OpenAIResponseStreamEvent,
} from "./openai-common";
import type { OpenAIV4Client } from "./openai-v4";
import type { OpenAIV5Client } from "./openai-v5";
import type { OpenAIV6Client } from "./openai-v6";

export type OpenAIVersion =
  | { majorVersion: 4; sdk: OpenAIV4Client }
  | { majorVersion: 5; sdk: OpenAIV5Client }
  | { majorVersion: 6; sdk: OpenAIV6Client };

export type OpenAIClient = OpenAIVersion["sdk"];

export type {
  OpenAIChatChoice,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatLogprobs,
  OpenAIChatCreateParams,
  OpenAIChatStream,
  OpenAIEmbeddingCreateParams,
  OpenAIEmbeddingResponse,
  OpenAIModerationCreateParams,
  OpenAIModerationResponse,
  OpenAIResponse,
  OpenAIResponseCompactParams,
  OpenAIResponseCompletedEvent,
  OpenAIResponseCreateParams,
  OpenAIResponseStreamEvent,
};
