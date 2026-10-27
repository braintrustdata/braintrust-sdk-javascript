import type { OpenAIMediaClient } from "./openai-media";
import type { OpenAIDecisionsClient } from "./openai-decisions";
import type {
  OpenAIBeta,
  OpenAIChat,
  OpenAIEmbeddings,
  OpenAIModerations,
  OpenAIResponses,
} from "./openai-common";

export interface OpenAIV4Client
  extends OpenAIMediaClient, OpenAIDecisionsClient {
  chat: OpenAIChat;
  embeddings: OpenAIEmbeddings;
  moderations: OpenAIModerations;
  beta?: OpenAIBeta;
  responses?: OpenAIResponses;
}
