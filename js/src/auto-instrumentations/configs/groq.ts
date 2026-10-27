import type { InstrumentationConfig } from "../orchestrion-js";
import { groqChannels } from "../../instrumentation/providers/groq-interceptors";

export const groqConfigs: InstrumentationConfig[] = [
  {
    channelName: groqChannels.chatCompletionsCreate.channelName,
    module: {
      name: "groq-sdk",
      versionRange: ">=1.0.0",
      filePath: "resources/chat/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "create",
    },
  },
  {
    channelName: groqChannels.embeddingsCreate.channelName,
    module: {
      name: "groq-sdk",
      versionRange: ">=1.0.0",
      filePath: "resources/embeddings.mjs",
    },
    functionQuery: {
      className: "Embeddings",
      methodName: "create",
    },
  },
  {
    channelName: groqChannels.audioSpeechCreate.channelName,
    module: {
      name: "groq-sdk",
      versionRange: ">=1.0.0",
      filePath: "resources/audio/speech.mjs",
    },
    functionQuery: {
      className: "Speech",
      methodName: "create",
    },
  },
  {
    channelName: groqChannels.audioTranscriptionsCreate.channelName,
    module: {
      name: "groq-sdk",
      versionRange: ">=1.0.0",
      filePath: "resources/audio/transcriptions.mjs",
    },
    functionQuery: {
      className: "Transcriptions",
      methodName: "create",
    },
  },
  {
    channelName: groqChannels.audioTranslationsCreate.channelName,
    module: {
      name: "groq-sdk",
      versionRange: ">=1.0.0",
      filePath: "resources/audio/translations.mjs",
    },
    functionQuery: {
      className: "Translations",
      methodName: "create",
    },
  },
];
