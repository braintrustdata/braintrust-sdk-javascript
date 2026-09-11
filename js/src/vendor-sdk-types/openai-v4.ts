import type { OpenAIMediaClient } from "./openai-media";
import type {
  OpenAIBeta,
  OpenAIChat,
  OpenAIEmbeddings,
  OpenAIModerations,
  OpenAIResponses,
} from "./openai-common";

export interface OpenAIV4Client extends OpenAIMediaClient {
  chat: OpenAIChat;
  embeddings: OpenAIEmbeddings;
  moderations: OpenAIModerations;
  beta?: OpenAIBeta;
  responses?: OpenAIResponses;
}
