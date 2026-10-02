import { channel, defineInterceptor } from "../core/channel-definitions";

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

export const cohereChannels = defineInterceptor("cohere-ai", {
  chat: channel<[CohereChatRequest], PromiseLike<CohereChatResponse>>({
    channelName: "chat",
  }),

  chatStream: channel<
    [CohereChatRequest],
    PromiseLike<CohereChatStreamResult>,
    Record<string, unknown>,
    CohereChatStreamEvent
  >({
    channelName: "chatStream",
  }),

  embed: channel<[CohereEmbedRequest], PromiseLike<CohereEmbedResponse>>({
    channelName: "embed",
  }),

  rerank: channel<[CohereRerankRequest], PromiseLike<CohereRerankResponse>>({
    channelName: "rerank",
  }),
});
