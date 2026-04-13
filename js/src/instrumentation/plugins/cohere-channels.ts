import { channel, defineChannels } from "../core/channel-definitions";
import type {
  CohereChatRequest,
  CohereChatResponse,
  CohereChatStreamEvent,
  CohereChatStreamResult,
  CohereEmbedRequest,
  CohereEmbedResponse,
  CohereRerankRequest,
  CohereRerankResponse,
} from "../../vendor-sdk-types/cohere";

export const cohereChannels = defineChannels("cohere-ai", {
  chat: channel<[CohereChatRequest], CohereChatResponse>({
    channelName: "chat",
    kind: "async",
  }),

  chatStream: channel<
    [CohereChatRequest],
    CohereChatStreamResult,
    Record<string, unknown>,
    CohereChatStreamEvent
  >({
    channelName: "chatStream",
    kind: "async",
  }),

  embed: channel<[CohereEmbedRequest], CohereEmbedResponse>({
    channelName: "embed",
    kind: "async",
  }),

  rerank: channel<[CohereRerankRequest], CohereRerankResponse>({
    channelName: "rerank",
    kind: "async",
  }),
});
