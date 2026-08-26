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

    classifiersModerate: channel<
      [MistralClassificationCreateParams],
      MistralModerationResponse
    >({
      channelName: "classifiers.moderate",
      kind: "async",
    }),

    classifiersModerateChat: channel<
      [MistralChatClassificationCreateParams],
      MistralModerationResponse
    >({
      channelName: "classifiers.moderateChat",
      kind: "async",
    }),

    classifiersClassify: channel<
      [MistralClassificationCreateParams],
      MistralClassificationResponse
    >({
      channelName: "classifiers.classify",
      kind: "async",
    }),

    classifiersClassifyChat: channel<
      [MistralChatClassificationCreateParams],
      MistralClassificationResponse
    >({
      channelName: "classifiers.classifyChat",
      kind: "async",
    }),

    fimComplete: channel<
      [MistralFimCreateParams],
      MistralFimCompletionResponse
    >({
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
  },
  { instrumentationName: INSTRUMENTATION_NAMES.MISTRAL },
);
