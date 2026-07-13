import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import {
  smithyClientChannels,
  smithyCoreChannels,
} from "../../instrumentation/plugins/bedrock-runtime-channels";

export const bedrockRuntimeOrchestrionConfigs: InstrumentationConfig[] = [
  {
    channelName: smithyCoreChannels.clientSend.channelName,
    module: {
      name: "@smithy/core",
      versionRange: ">=3.0.0 <4.0.0",
      filePath: "dist-cjs/submodules/client/index.js",
    },
    functionQuery: {
      className: "Client",
      methodName: "send",
      kind: "Async",
    },
  },
  {
    channelName: smithyCoreChannels.clientSend.channelName,
    module: {
      name: "@smithy/core",
      versionRange: ">=3.0.0 <4.0.0",
      filePath: "dist-es/submodules/client/smithy-client/client.js",
    },
    functionQuery: {
      className: "Client",
      methodName: "send",
      kind: "Async",
    },
  },
  {
    channelName: smithyClientChannels.clientSend.channelName,
    module: {
      name: "@smithy/smithy-client",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist-cjs/index.js",
    },
    functionQuery: {
      className: "Client",
      methodName: "send",
      kind: "Async",
    },
  },
  {
    channelName: smithyClientChannels.clientSend.channelName,
    module: {
      name: "@smithy/smithy-client",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist-es/client.js",
    },
    functionQuery: {
      className: "Client",
      methodName: "send",
      kind: "Async",
    },
  },
];
