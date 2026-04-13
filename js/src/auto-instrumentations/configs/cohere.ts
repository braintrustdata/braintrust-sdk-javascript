import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { cohereChannels } from "../../instrumentation/plugins/cohere-channels";

export const cohereConfigs: InstrumentationConfig[] = [
  {
    channelName: cohereChannels.chat.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=7.0.0 <8.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "chat",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.chat.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "chat",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.chat.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "api/resources/v2/client/Client.js",
    },
    functionQuery: {
      className: "V2Client",
      methodName: "chat",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.chatStream.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=7.0.0 <8.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "chatStream",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.chatStream.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "chatStream",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.chatStream.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "api/resources/v2/client/Client.js",
    },
    functionQuery: {
      className: "V2Client",
      methodName: "chatStream",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.embed.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=7.0.0 <8.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "embed",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.embed.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "embed",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.embed.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "api/resources/v2/client/Client.js",
    },
    functionQuery: {
      className: "V2Client",
      methodName: "embed",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.rerank.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=7.0.0 <8.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "rerank",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.rerank.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "Client.js",
    },
    functionQuery: {
      className: "CohereClient",
      methodName: "rerank",
      kind: "Async",
    },
  },
  {
    channelName: cohereChannels.rerank.channelName,
    module: {
      name: "cohere-ai",
      versionRange: ">=8.0.0 <9.0.0",
      filePath: "api/resources/v2/client/Client.js",
    },
    functionQuery: {
      className: "V2Client",
      methodName: "rerank",
      kind: "Async",
    },
  },
];
