import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { langChainChannels } from "../../instrumentation/plugins/langchain-channels";

const langChainCoreVersionRange = ">=0.3.42";
const langChainCallbackManagerFilePath = "dist/callbacks/manager.js";

export const langchainConfigs: InstrumentationConfig[] = [
  {
    channelName: langChainChannels.configure.channelName,
    module: {
      name: "@langchain/core",
      versionRange: langChainCoreVersionRange,
      filePath: langChainCallbackManagerFilePath,
    },
    functionQuery: {
      className: "CallbackManager",
      methodName: "configure",
      kind: "Sync",
    },
  },
  {
    channelName: langChainChannels.configureSync.channelName,
    module: {
      name: "@langchain/core",
      versionRange: langChainCoreVersionRange,
      filePath: langChainCallbackManagerFilePath,
    },
    functionQuery: {
      className: "CallbackManager",
      methodName: "_configureSync",
      kind: "Sync",
    },
  },
];
