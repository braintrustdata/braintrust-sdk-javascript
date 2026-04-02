import { channel, defineChannels } from "../core/channel-definitions";
import type {
  MistralAgentsCompletionEvent,
  MistralAgentsCompletionResponse,
  MistralAgentsCreateParams,
  MistralAgentsResult,
  MistralChatCompletionEvent,
  MistralChatCompletionResponse,
  MistralChatCreateParams,
  MistralChatResult,
  MistralEmbeddingCreateParams,
  MistralEmbeddingResponse,
  MistralFimCompletionEvent,
  MistralFimCompletionResponse,
  MistralFimCreateParams,
  MistralFimResult,
} from "../../vendor-sdk-types/mistral";

export const mistralChannels = defineChannels("@mistralai/mistralai", {
  chatComplete: channel<
    [MistralChatCreateParams],
    MistralChatCompletionResponse
  >({
    channelName: "chat.complete",
    kind: "async",
  }),

  chatStream: channel<
    [MistralChatCreateParams],
    MistralChatResult,
    Record<string, unknown>,
    MistralChatCompletionEvent
  >({
    channelName: "chat.stream",
    kind: "async",
  }),

  embeddingsCreate: channel<
    [MistralEmbeddingCreateParams],
    MistralEmbeddingResponse
  >({
    channelName: "embeddings.create",
    kind: "async",
  }),

  fimComplete: channel<[MistralFimCreateParams], MistralFimCompletionResponse>({
    channelName: "fim.complete",
    kind: "async",
  }),

  fimStream: channel<
    [MistralFimCreateParams],
    MistralFimResult,
    Record<string, unknown>,
    MistralFimCompletionEvent
  >({
    channelName: "fim.stream",
    kind: "async",
  }),

  agentsComplete: channel<
    [MistralAgentsCreateParams],
    MistralAgentsCompletionResponse
  >({
    channelName: "agents.complete",
    kind: "async",
  }),

  agentsStream: channel<
    [MistralAgentsCreateParams],
    MistralAgentsResult,
    Record<string, unknown>,
    MistralAgentsCompletionEvent
  >({
    channelName: "agents.stream",
    kind: "async",
  }),
});
