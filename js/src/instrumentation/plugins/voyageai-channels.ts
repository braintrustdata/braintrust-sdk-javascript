import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  VoyageAIContextualizedEmbedRequest,
  VoyageAIContextualizedResult,
  VoyageAIEmbeddingResponse,
  VoyageAIEmbedRequest,
  VoyageAIMultimodalEmbedRequest,
  VoyageAIRerankRequest,
  VoyageAIRerankResponse,
} from "../../vendor-sdk-types/voyageai";

export const voyageAIChannels = defineChannels(
  "voyageai",
  {
    embed: channel<[VoyageAIEmbedRequest], VoyageAIEmbeddingResponse>({
      channelName: "embed",
      kind: "async",
    }),

    multimodalEmbed: channel<
      [VoyageAIMultimodalEmbedRequest],
      VoyageAIEmbeddingResponse
    >({
      channelName: "multimodalEmbed",
      kind: "async",
    }),

    rerank: channel<[VoyageAIRerankRequest], VoyageAIRerankResponse>({
      channelName: "rerank",
      kind: "async",
    }),

    contextualizedEmbed: channel<
      [VoyageAIContextualizedEmbedRequest],
      VoyageAIContextualizedResult
    >({
      channelName: "contextualizedEmbed",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.VOYAGEAI },
);
