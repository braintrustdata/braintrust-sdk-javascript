import type { OpenAIMediaClient } from "./openai-media";
import type { OpenAIDecisionsClient } from "./openai-decisions";
import type {
  OpenAIBeta,
  OpenAIChatWithParsing,
  OpenAIEmbeddings,
  OpenAIModerations,
  OpenAIResponsesWithParsing,
} from "./openai-common";

export interface OpenAIV5Client
  extends OpenAIMediaClient, OpenAIDecisionsClient {
  chat: OpenAIChatWithParsing;
  embeddings: OpenAIEmbeddings;
  moderations: OpenAIModerations;
  beta?: OpenAIBeta;
  responses?: OpenAIResponsesWithParsing;
}
