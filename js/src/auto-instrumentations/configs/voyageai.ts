import type { InstrumentationConfig } from "../orchestrion-js";
import { voyageAIChannels } from "../../instrumentation/plugins/voyageai-channels";

const GENERATED_CLIENT_MODULES = [
  "dist/cjs/Client.js",
  "dist/esm/Client.mjs",
] as const;

const generatedClientOperations = [
  {
    channelName: voyageAIChannels.embed.channelName,
    methodName: "embed",
    versionRange: ">=0.2.0 <1.0.0",
  },
  {
    channelName: voyageAIChannels.multimodalEmbed.channelName,
    methodName: "multimodalEmbed",
    versionRange: ">=0.2.0 <1.0.0",
  },
  {
    channelName: voyageAIChannels.rerank.channelName,
    methodName: "rerank",
    versionRange: ">=0.2.0 <1.0.0",
  },
  {
    channelName: voyageAIChannels.contextualizedEmbed.channelName,
    methodName: "contextualizedEmbed",
    versionRange: ">=0.2.0 <1.0.0",
  },
] as const;

export const voyageAIConfigs: InstrumentationConfig[] = [
  ...GENERATED_CLIENT_MODULES.flatMap((filePath) =>
    generatedClientOperations.map(
      ({ channelName, methodName, versionRange }) => ({
        channelName,
        module: {
          name: "voyageai",
          versionRange,
          filePath,
        },
        functionQuery: {
          className: "VoyageAIClient",
          methodName,
          kind: "Async" as const,
        },
      }),
    ),
  ),
];
