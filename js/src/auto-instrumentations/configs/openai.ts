import type { InstrumentationConfig } from "../orchestrion-js";
import { openAIChannels } from "../../instrumentation/providers/openai-interceptors";

/**
 * Instrumentation configurations for the OpenAI SDK.
 *
 * These configs define which functions to instrument and what channel
 * to emit events on. They are used by orchestrion-js to perform AST
 * transformation at build-time or load-time.
 *
 * NOTE: Channel names should NOT include the orchestrion: prefix. The code-transformer
 * will prepend "orchestrion:" + module.name + ":" to these names, resulting in final channel names like:
 * "orchestrion:openai:chat.completions.create"
 */
export const openaiConfigs: InstrumentationConfig[] = [
  ...["resources/decisions.mjs", "resources/decisions.js"].map(
    (filePath): InstrumentationConfig => ({
      channelName: openAIChannels.decisionsCreate.channelName,
      module: {
        name: "openai",
        versionRange: ">=7.30.0",
        filePath,
      },
      functionQuery: {
        className: "Decisions",
        methodName: "create",
      },
    }),
  ),
  {
    channelName: openAIChannels.imagesGenerate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/images.mjs",
    },
    functionQuery: {
      className: "Images",
      methodName: "generate",
    },
  },
  {
    channelName: openAIChannels.imagesEdit.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/images.mjs",
    },
    functionQuery: { className: "Images", methodName: "edit" },
  },
  {
    channelName: openAIChannels.imagesCreateVariation.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/images.mjs",
    },
    functionQuery: {
      className: "Images",
      methodName: "createVariation",
    },
  },
  {
    channelName: openAIChannels.audioSpeechCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/audio/speech.mjs",
    },
    functionQuery: { className: "Speech", methodName: "create" },
  },
  {
    channelName: openAIChannels.audioTranscriptionsCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/audio/transcriptions.mjs",
    },
    functionQuery: {
      className: "Transcriptions",
      methodName: "create",
    },
  },
  {
    channelName: openAIChannels.audioTranslationsCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/audio/translations.mjs",
    },
    functionQuery: {
      className: "Translations",
      methodName: "create",
    },
  },
  // Chat Completions
  {
    channelName: openAIChannels.chatCompletionsCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/chat/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "create",
    },
  },

  {
    channelName: openAIChannels.chatCompletionsCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "create",
    },
  },

  {
    channelName: openAIChannels.chatCompletionsCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "create",
    },
  },

  // Embeddings
  {
    channelName: openAIChannels.embeddingsCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/embeddings.mjs",
    },
    functionQuery: {
      className: "Embeddings",
      methodName: "create",
    },
  },

  // Beta Chat Completions Parse
  {
    channelName: openAIChannels.betaChatCompletionsParse.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/beta/chat/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "parse",
    },
  },

  {
    channelName: openAIChannels.betaChatCompletionsParse.channelName,
    module: {
      name: "openai",
      versionRange: ">=5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "parse",
    },
  },

  // Moderations
  {
    channelName: openAIChannels.moderationsCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/moderations.mjs",
    },
    functionQuery: {
      className: "Moderations",
      methodName: "create",
    },
  },

  // Beta Chat Completions Stream
  {
    channelName: openAIChannels.betaChatCompletionsStream.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/beta/chat/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "stream",
    },
  },

  {
    channelName: openAIChannels.betaChatCompletionsStream.channelName,
    module: {
      name: "openai",
      versionRange: ">=5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "stream",
    },
  },

  // Responses API (v4.87.0+)
  {
    channelName: openAIChannels.responsesCreate.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.87.0",
      filePath: "resources/responses/responses.mjs",
    },
    functionQuery: {
      className: "Responses",
      methodName: "create",
    },
  },

  {
    channelName: openAIChannels.responsesStream.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.87.0",
      filePath: "resources/responses/responses.mjs",
    },
    functionQuery: {
      className: "Responses",
      methodName: "stream",
    },
  },

  {
    channelName: openAIChannels.responsesParse.channelName,
    module: {
      name: "openai",
      versionRange: ">=4.87.0",
      filePath: "resources/responses/responses.mjs",
    },
    functionQuery: {
      className: "Responses",
      methodName: "parse",
    },
  },

  {
    channelName: openAIChannels.responsesCompact.channelName,
    module: {
      name: "openai",
      versionRange: ">=6.10.0",
      filePath: "resources/responses/responses.mjs",
    },
    functionQuery: {
      className: "Responses",
      methodName: "compact",
    },
  },
];
