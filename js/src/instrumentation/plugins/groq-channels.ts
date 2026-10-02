import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  GroqAudioSpeechCreateParams,
  GroqAudioTextResult,
  GroqAudioTranscriptionCreateParams,
  GroqAudioTranslationCreateParams,
  GroqChatCompletion,
  GroqChatCompletionChunk,
  GroqChatCreateParams,
  GroqChatStream,
  GroqEmbeddingCreateParams,
  GroqEmbeddingResponse,
} from "../../vendor-sdk-types/groq";

type GroqChatResult = GroqChatCompletion | GroqChatStream;

export const groqChannels = defineInterceptor("groq-sdk", {
  chatCompletionsCreate: channel<
    [GroqChatCreateParams, unknown?],
    PromiseLike<GroqChatResult>,
    Record<string, unknown>,
    GroqChatCompletionChunk
  >({
    channelName: "chat.completions.create",
  }),

  embeddingsCreate: channel<
    [GroqEmbeddingCreateParams, unknown?],
    PromiseLike<GroqEmbeddingResponse>
  >({
    channelName: "embeddings.create",
  }),

  audioSpeechCreate: channel<
    [GroqAudioSpeechCreateParams, unknown?],
    PromiseLike<Response>
  >({
    channelName: "audio.speech.create",
  }),

  audioTranscriptionsCreate: channel<
    [GroqAudioTranscriptionCreateParams, unknown?],
    PromiseLike<GroqAudioTextResult | string>
  >({
    channelName: "audio.transcriptions.create",
  }),

  audioTranslationsCreate: channel<
    [GroqAudioTranslationCreateParams, unknown?],
    PromiseLike<GroqAudioTextResult | string>
  >({
    channelName: "audio.translations.create",
  }),
});
