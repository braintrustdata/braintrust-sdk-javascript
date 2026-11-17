import { channel, defineInterceptor } from "../core/interceptor-definitions";

import type {
  MistralOCRParams,
  MistralOCRResponse,
  MistralTranscriptionParams,
  MistralTranscriptionResponse,
  MistralTranscriptionEvent,
  MistralSpeechParams,
  MistralSpeechResult,
  MistralSpeechEvent,
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

export const mistralChannels = defineInterceptor("@mistralai/mistralai", {
  ocrProcess: channel<[MistralOCRParams], PromiseLike<MistralOCRResponse>>({
    channelName: "ocr.process",
  }),
  transcriptionsComplete: channel<
    [MistralTranscriptionParams],
    PromiseLike<MistralTranscriptionResponse>
  >({ channelName: "audio.transcriptions.complete" }),
  transcriptionsStream: channel<
    [MistralTranscriptionParams],
    PromiseLike<AsyncIterable<MistralTranscriptionEvent>>,
    Record<string, unknown>,
    MistralTranscriptionEvent
  >({ channelName: "audio.transcriptions.stream" }),
  speechComplete: channel<
    [MistralSpeechParams],
    PromiseLike<MistralSpeechResult>,
    Record<string, unknown>,
    MistralSpeechEvent
  >({ channelName: "audio.speech.complete" }),
  chatComplete: channel<
    [MistralChatCreateParams],
    PromiseLike<MistralChatCompletionResponse>
  >({
    channelName: "chat.complete",
  }),

  chatStream: channel<
    [MistralChatCreateParams],
    PromiseLike<MistralChatResult>,
    Record<string, unknown>,
    MistralChatCompletionEvent
  >({
    channelName: "chat.stream",
  }),

  embeddingsCreate: channel<
    [MistralEmbeddingCreateParams],
    PromiseLike<MistralEmbeddingResponse>
  >({
    channelName: "embeddings.create",
  }),

  classifiersModerate: channel<
    [MistralClassificationCreateParams],
    PromiseLike<MistralModerationResponse>
  >({
    channelName: "classifiers.moderate",
  }),

  classifiersModerateChat: channel<
    [MistralChatClassificationCreateParams],
    PromiseLike<MistralModerationResponse>
  >({
    channelName: "classifiers.moderateChat",
  }),

  classifiersClassify: channel<
    [MistralClassificationCreateParams],
    PromiseLike<MistralClassificationResponse>
  >({
    channelName: "classifiers.classify",
  }),

  classifiersClassifyChat: channel<
    [MistralChatClassificationCreateParams],
    PromiseLike<MistralClassificationResponse>
  >({
    channelName: "classifiers.classifyChat",
  }),

  fimComplete: channel<
    [MistralFimCreateParams],
    PromiseLike<MistralFimCompletionResponse>
  >({
    channelName: "fim.complete",
  }),

  fimStream: channel<
    [MistralFimCreateParams],
    PromiseLike<MistralFimResult>,
    Record<string, unknown>,
    MistralFimCompletionEvent
  >({
    channelName: "fim.stream",
  }),

  agentsComplete: channel<
    [MistralAgentsCreateParams],
    PromiseLike<MistralAgentsCompletionResponse>
  >({
    channelName: "agents.complete",
  }),

  agentsStream: channel<
    [MistralAgentsCreateParams],
    PromiseLike<MistralAgentsResult>,
    Record<string, unknown>,
    MistralAgentsCompletionEvent
  >({
    channelName: "agents.stream",
  }),
});
