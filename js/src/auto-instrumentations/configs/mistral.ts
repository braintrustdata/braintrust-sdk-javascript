import type { InstrumentationConfig } from "../orchestrion-js";
import { mistralChannels } from "../../instrumentation/providers/mistral-interceptors";

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
    },
  },

  {
    channelName: mistralChannels.classifiersModerate.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "moderate",
    },
  },

  {
    channelName: mistralChannels.classifiersModerate.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "moderate",
    },
  },

  {
    channelName: mistralChannels.classifiersModerateChat.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "moderateChat",
    },
  },

  {
    channelName: mistralChannels.classifiersModerateChat.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "moderateChat",
    },
  },

  {
    channelName: mistralChannels.classifiersClassify.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.10.0 <2.0.0",
      filePath: "sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "classify",
    },
  },

  {
    channelName: mistralChannels.classifiersClassify.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "classify",
    },
  },

  {
    channelName: mistralChannels.classifiersClassifyChat.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=1.10.0 <2.0.0",
      filePath: "sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "classifyChat",
    },
  },

  {
    channelName: mistralChannels.classifiersClassifyChat.channelName,
    module: {
      name: "@mistralai/mistralai",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "esm/sdk/classifiers.js",
    },
    functionQuery: {
      className: "Classifiers",
      methodName: "classifyChat",
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
    },
  },
];
