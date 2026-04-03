import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { mistralChannels } from "../../instrumentation/plugins/mistral-channels";

export const mistralConfigs: InstrumentationConfig[] = [
  {
    channelName: mistralChannels.chatComplete.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/chat.js",
    },
    functionQuery: {
      className: "Chat",
      methodName: "complete",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.chatComplete.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/chat.js",
    },
    functionQuery: {
      className: "Chat",
      methodName: "complete",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.chatStream.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/chat.js",
    },
    functionQuery: {
      className: "Chat",
      methodName: "stream",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.chatStream.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/chat.js",
    },
    functionQuery: {
      className: "Chat",
      methodName: "stream",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.embeddingsCreate.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/embeddings.js",
    },
    functionQuery: {
      className: "Embeddings",
      methodName: "create",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.embeddingsCreate.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/embeddings.js",
    },
    functionQuery: {
      className: "Embeddings",
      methodName: "create",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.fimComplete.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/fim.js",
    },
    functionQuery: {
      className: "Fim",
      methodName: "complete",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.fimComplete.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/fim.js",
    },
    functionQuery: {
      className: "Fim",
      methodName: "complete",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.fimStream.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/fim.js",
    },
    functionQuery: {
      className: "Fim",
      methodName: "stream",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.fimStream.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/fim.js",
    },
    functionQuery: {
      className: "Fim",
      methodName: "stream",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.agentsComplete.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/agents.js",
    },
    functionQuery: {
      className: "Agents",
      methodName: "complete",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.agentsComplete.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/agents.js",
    },
    functionQuery: {
      className: "Agents",
      methodName: "complete",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.agentsStream.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/agents.js",
    },
    functionQuery: {
      className: "Agents",
      methodName: "stream",
      kind: "Async",
    },
  },

  {
    channelName: mistralChannels.agentsStream.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/agents.js",
    },
    functionQuery: {
      className: "Agents",
      methodName: "stream",
      kind: "Async",
    },
  },
];
