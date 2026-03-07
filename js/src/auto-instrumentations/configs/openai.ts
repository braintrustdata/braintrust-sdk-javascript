import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { OPENAI_CHANNEL_SUFFIX } from "../../instrumentation/plugins/channels";

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
  // Chat Completions
  {
    channelName: OPENAI_CHANNEL_SUFFIX.CHAT_COMPLETIONS_CREATE,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/chat/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "create",
      kind: "Async",
    },
  },

  {
    channelName: OPENAI_CHANNEL_SUFFIX.CHAT_COMPLETIONS_CREATE,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "create",
      kind: "Async",
    },
  },

  {
    channelName: OPENAI_CHANNEL_SUFFIX.CHAT_COMPLETIONS_CREATE,
    module: {
      name: "openai",
      versionRange: ">=5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "create",
      kind: "Async",
    },
  },

  // Embeddings
  {
    channelName: OPENAI_CHANNEL_SUFFIX.EMBEDDINGS_CREATE,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/embeddings.mjs",
    },
    functionQuery: {
      className: "Embeddings",
      methodName: "create",
      kind: "Async",
    },
  },

  // Beta Chat Completions Parse
  {
    channelName: OPENAI_CHANNEL_SUFFIX.BETA_CHAT_COMPLETIONS_PARSE,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/beta/chat/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "parse",
      kind: "Async",
    },
  },

  {
    channelName: OPENAI_CHANNEL_SUFFIX.BETA_CHAT_COMPLETIONS_PARSE,
    module: {
      name: "openai",
      versionRange: ">=5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "parse",
      kind: "Async",
    },
  },

  // Moderations
  {
    channelName: OPENAI_CHANNEL_SUFFIX.MODERATIONS_CREATE,
    module: {
      name: "openai",
      versionRange: ">=4.0.0",
      filePath: "resources/moderations.mjs",
    },
    functionQuery: {
      className: "Moderations",
      methodName: "create",
      kind: "Async",
    },
  },

  // Beta Chat Completions Stream
  {
    channelName: OPENAI_CHANNEL_SUFFIX.BETA_CHAT_COMPLETIONS_STREAM,
    module: {
      name: "openai",
      versionRange: ">=4.0.0 <5.0.0",
      filePath: "resources/beta/chat/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "stream",
      kind: "Sync",
    },
  },

  {
    channelName: OPENAI_CHANNEL_SUFFIX.BETA_CHAT_COMPLETIONS_STREAM,
    module: {
      name: "openai",
      versionRange: ">=5.0.0",
      filePath: "resources/chat/completions/completions.mjs",
    },
    functionQuery: {
      className: "Completions",
      methodName: "stream",
      kind: "Sync",
    },
  },

  // Responses API (v4.87.0+)
  {
    channelName: OPENAI_CHANNEL_SUFFIX.RESPONSES_CREATE,
    module: {
      name: "openai",
      versionRange: ">=4.87.0",
      filePath: "resources/responses/responses.mjs",
    },
    functionQuery: {
      className: "Responses",
      methodName: "create",
      kind: "Async",
    },
  },

  {
    channelName: OPENAI_CHANNEL_SUFFIX.RESPONSES_STREAM,
    module: {
      name: "openai",
      versionRange: ">=4.87.0",
      filePath: "resources/responses/responses.mjs",
    },
    functionQuery: {
      className: "Responses",
      methodName: "stream",
      kind: "Sync",
    },
  },

  {
    channelName: OPENAI_CHANNEL_SUFFIX.RESPONSES_PARSE,
    module: {
      name: "openai",
      versionRange: ">=4.87.0",
      filePath: "resources/responses/responses.mjs",
    },
    functionQuery: {
      className: "Responses",
      methodName: "parse",
      kind: "Async",
    },
  },
];
