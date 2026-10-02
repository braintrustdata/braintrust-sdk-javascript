import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  VoyageAIContextualizedEmbedRequest,
  VoyageAIContextualizedResult,
  VoyageAIEmbeddingResponse,
  VoyageAIEmbedRequest,
  VoyageAIMultimodalEmbedRequest,
  VoyageAIRerankRequest,
  VoyageAIRerankResponse,
} from "../../vendor-sdk-types/voyageai";

export const voyageAIChannels = defineInterceptor("voyageai", {
  embed: channel<
    [VoyageAIEmbedRequest, options?: unknown],
    PromiseLike<VoyageAIEmbeddingResponse>
  >({
    channelName: "embed",
  }),

  multimodalEmbed: channel<
    [VoyageAIMultimodalEmbedRequest, options?: unknown],
    PromiseLike<VoyageAIEmbeddingResponse>
  >({
    channelName: "multimodalEmbed",
  }),

  rerank: channel<
    [VoyageAIRerankRequest, options?: unknown],
    PromiseLike<VoyageAIRerankResponse>
  >({
    channelName: "rerank",
  }),

  contextualizedEmbed: channel<
    [VoyageAIContextualizedEmbedRequest, options?: unknown],
    PromiseLike<VoyageAIContextualizedResult>
  >({
    channelName: "contextualizedEmbed",
  }),
});
