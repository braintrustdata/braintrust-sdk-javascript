import type { InstrumentationConfig } from "../orchestrion-js";
import { langGraphSDKChannels } from "../../instrumentation/providers/langgraph-sdk-interceptors";

// Both entrypoints share RunsClient. v2 bundles the subclients into client.*.
export const langGraphSDKConfigs: InstrumentationConfig[] = [
  { versionRange: ">=1.9.25 <2.0.0", filePath: "dist/client/runs/index" },
  { versionRange: ">=2.0.0 <3.0.0", filePath: "dist/client" },
].flatMap(({ versionRange, filePath }) =>
  ["js", "cjs"].flatMap((extension) =>
    (["wait", "stream"] as const).map((methodName) => ({
      channelName: langGraphSDKChannels[methodName].channelName,
      module: {
        name: "@langchain/langgraph-sdk",
        versionRange,
        filePath: `${filePath}.${extension}`,
      },
      functionQuery: {
        className: "RunsClient",
        methodName,
      },
    })),
  ),
);
