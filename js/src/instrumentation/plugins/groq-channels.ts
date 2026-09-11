import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
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

export const groqChannels = defineChannels(
  "groq-sdk",
  {
    chatCompletionsCreate: channel<
      [GroqChatCreateParams, unknown?],
      GroqChatResult,
      Record<string, unknown>,
      GroqChatCompletionChunk
    >({
      channelName: "chat.completions.create",
      kind: "async",
    }),

    embeddingsCreate: channel<
      [GroqEmbeddingCreateParams, unknown?],
      GroqEmbeddingResponse
    >({
      channelName: "embeddings.create",
      kind: "async",
    }),

    audioSpeechCreate: channel<
      [GroqAudioSpeechCreateParams, unknown?],
      Response
    >({
      channelName: "audio.speech.create",
      kind: "async",
    }),

    audioTranscriptionsCreate: channel<
      [GroqAudioTranscriptionCreateParams, unknown?],
      GroqAudioTextResult | string
    >({
      channelName: "audio.transcriptions.create",
      kind: "async",
    }),

    audioTranslationsCreate: channel<
      [GroqAudioTranslationCreateParams, unknown?],
      GroqAudioTextResult | string
    >({
      channelName: "audio.translations.create",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.GROQ },
);
