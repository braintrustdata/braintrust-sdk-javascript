import type { InstrumentationConfig } from "../orchestrion-js";
import { langGraphSDKChannels } from "../../instrumentation/providers/langgraph-sdk-interceptors";

// These public methods live in shared subclients for both package entrypoints.
export const langGraphSDKConfigs: InstrumentationConfig[] = [
  "js",
  "cjs",
].flatMap((extension) =>
  (["wait", "stream"] as const).map((methodName) => ({
    channelName: langGraphSDKChannels[methodName].channelName,
    module: {
      name: "@langchain/langgraph-sdk",
      versionRange: ">=1.9.25 <2.0.0",
      filePath: `dist/client/runs/index.${extension}`,
    },
    functionQuery: {
      className: "RunsClient",
      methodName,
    },
  })),
);
