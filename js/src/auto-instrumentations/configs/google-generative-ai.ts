import type { InstrumentationConfig } from "../orchestrion-js";
import { googleGenerativeAIChannels } from "../../instrumentation/plugins/google-generative-ai-channels";

export const googleGenerativeAIConfigs: InstrumentationConfig[] = [
  "dist/index.js",
  "dist/index.mjs",
].flatMap((filePath) =>
  Object.entries(googleGenerativeAIChannels).map(([methodName, channel]) => ({
    channelName: channel.channelName,
    module: {
      name: "@google/generative-ai",
      versionRange: ">=0.24.0 <0.25.0",
      filePath,
    },
    functionQuery: {
      className: methodName.startsWith("sendMessage")
        ? "ChatSession"
        : "GenerativeModel",
      methodName,
      kind: "Async" as const,
    },
  })),
);
