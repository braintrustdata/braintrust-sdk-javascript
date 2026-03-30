import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { openRouterChannels } from "../../instrumentation/plugins/openrouter-channels";

export const openRouterConfigs: InstrumentationConfig[] = [
  {
    channelName: openRouterChannels.chatSend.channelName,
    module: {
      name: "@openrouter/sdk",
      versionRange: ">=0.9.11 <1.0.0",
      filePath: "esm/sdk/chat.js",
    },
    functionQuery: {
      className: "Chat",
      methodName: "send",
      kind: "Async",
    },
  },

  {
    channelName: openRouterChannels.embeddingsGenerate.channelName,
    module: {
      name: "@openrouter/sdk",
      versionRange: ">=0.9.11 <1.0.0",
      filePath: "esm/sdk/embeddings.js",
    },
    functionQuery: {
      className: "Embeddings",
      methodName: "generate",
      kind: "Async",
    },
  },

  {
    channelName: openRouterChannels.betaResponsesSend.channelName,
    module: {
      name: "@openrouter/sdk",
      versionRange: ">=0.9.11 <1.0.0",
      filePath: "esm/sdk/responses.js",
    },
    functionQuery: {
      className: "Responses",
      methodName: "send",
      kind: "Async",
    },
  },

  {
    channelName: openRouterChannels.callModel.channelName,
    module: {
      name: "@openrouter/sdk",
      versionRange: ">=0.9.11 <1.0.0",
      filePath: "esm/sdk/sdk.js",
    },
    functionQuery: {
      className: "OpenRouter",
      methodName: "callModel",
      kind: "Sync",
    },
  },
];
