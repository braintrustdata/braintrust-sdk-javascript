import { channel, defineChannels } from "../core/channel-definitions";
import type {
  GroqChatChoice,
  GroqChatCompletion,
  GroqChatCompletionChunk,
  GroqChatCreateParams,
  GroqChatStream,
  GroqEmbeddingCreateParams,
  GroqEmbeddingResponse,
} from "../../vendor-sdk-types/groq";

type GroqChatResult = GroqChatCompletion | GroqChatStream;

export const groqChannels = defineChannels("groq-sdk", {
  chatCompletionsCreate: channel<
    [GroqChatCreateParams],
    GroqChatResult,
    Record<string, unknown>,
    GroqChatCompletionChunk
  >({
    channelName: "chat.completions.create",
    kind: "async",
  }),

  embeddingsCreate: channel<[GroqEmbeddingCreateParams], GroqEmbeddingResponse>(
    {
      channelName: "embeddings.create",
      kind: "async",
    },
  ),
});

export type GroqChatResultChoice = GroqChatChoice;
