import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  MistralAgentsCompletionEvent,
  MistralAgentsCompletionResponse,
  MistralAgentsCreateParams,
  MistralAgentsResult,
  MistralChatClassificationCreateParams,
  MistralChatCompletionEvent,
  MistralChatCompletionResponse,
  MistralChatCreateParams,
  MistralChatResult,
  MistralClassificationCreateParams,
  MistralClassificationResponse,
  MistralEmbeddingCreateParams,
  MistralEmbeddingResponse,
  MistralFimCompletionEvent,
  MistralFimCompletionResponse,
  MistralFimCreateParams,
  MistralFimResult,
  MistralModerationResponse,
} from "../../vendor-sdk-types/mistral";

export const mistralChannels = defineChannels(
  "@mistralai/mistralai",
  {
    chatComplete: channel<
      [MistralChatCreateParams, unknown?],
      MistralChatCompletionResponse
    >({
      channelName: "chat.complete",
      kind: "async",
    }),

    chatStream: channel<
      [MistralChatCreateParams, unknown?],
      MistralChatResult,
      Record<string, unknown>,
      MistralChatCompletionEvent
    >({
      channelName: "chat.stream",
      kind: "async",
    }),

    embeddingsCreate: channel<
      [MistralEmbeddingCreateParams, unknown?],
      MistralEmbeddingResponse
    >({
      channelName: "embeddings.create",
      kind: "async",
    }),

    classifiersModerate: channel<
      [MistralClassificationCreateParams, unknown?],
      MistralModerationResponse
    >({
      channelName: "classifiers.moderate",
      kind: "async",
    }),

    classifiersModerateChat: channel<
      [MistralChatClassificationCreateParams, unknown?],
      MistralModerationResponse
    >({
      channelName: "classifiers.moderateChat",
      kind: "async",
    }),

    classifiersClassify: channel<
      [MistralClassificationCreateParams, unknown?],
      MistralClassificationResponse
    >({
      channelName: "classifiers.classify",
      kind: "async",
    }),

    classifiersClassifyChat: channel<
      [MistralChatClassificationCreateParams, unknown?],
      MistralClassificationResponse
    >({
      channelName: "classifiers.classifyChat",
      kind: "async",
    }),

    fimComplete: channel<
      [MistralFimCreateParams, unknown?],
      MistralFimCompletionResponse
    >({
      channelName: "fim.complete",
      kind: "async",
    }),

    fimStream: channel<
      [MistralFimCreateParams, unknown?],
      MistralFimResult,
      Record<string, unknown>,
      MistralFimCompletionEvent
    >({
      channelName: "fim.stream",
      kind: "async",
    }),

    agentsComplete: channel<
      [MistralAgentsCreateParams, unknown?],
      MistralAgentsCompletionResponse
    >({
      channelName: "agents.complete",
      kind: "async",
    }),

    agentsStream: channel<
      [MistralAgentsCreateParams, unknown?],
      MistralAgentsResult,
      Record<string, unknown>,
      MistralAgentsCompletionEvent
    >({
      channelName: "agents.stream",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.MISTRAL },
);
