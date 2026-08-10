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
    embed: channel<
      [VoyageAIEmbedRequest, options?: unknown],
      VoyageAIEmbeddingResponse
    >({
      channelName: "embed",
      kind: "async",
    }),

    multimodalEmbed: channel<
      [VoyageAIMultimodalEmbedRequest, options?: unknown],
      VoyageAIEmbeddingResponse
    >({
      channelName: "multimodalEmbed",
      kind: "async",
    }),

    rerank: channel<
      [VoyageAIRerankRequest, options?: unknown],
      VoyageAIRerankResponse
    >({
      channelName: "rerank",
      kind: "async",
    }),

    contextualizedEmbed: channel<
      [VoyageAIContextualizedEmbedRequest, options?: unknown],
      VoyageAIContextualizedResult
    >({
      channelName: "contextualizedEmbed",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.VOYAGEAI },
);
