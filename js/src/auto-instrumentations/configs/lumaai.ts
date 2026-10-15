import type { InstrumentationConfig } from "../orchestrion-js";
import { lumaAIChannels } from "../../instrumentation/plugins/lumaai-interceptors";

export const lumaAIConfigs: InstrumentationConfig[] = ["js", "mjs"].flatMap(
  (extension) => [
    {
      channelName: lumaAIChannels.generationsCreate.channelName,
      module: {
        name: "lumaai",
        versionRange: ">=1.19.1 <2.0.0",
        filePath: `resources/generations/generations.${extension}`,
      },
      functionQuery: { className: "Generations", methodName: "create" },
    },
    {
      channelName: lumaAIChannels.generationsGet.channelName,
      module: {
        name: "lumaai",
        versionRange: ">=1.19.1 <2.0.0",
        filePath: `resources/generations/generations.${extension}`,
      },
      functionQuery: { className: "Generations", methodName: "get" },
    },
  ],
);
