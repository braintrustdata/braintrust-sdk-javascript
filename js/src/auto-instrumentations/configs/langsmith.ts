import type { InstrumentationConfig } from "../orchestrion-js";
import { langSmithChannels } from "../../instrumentation/plugins/langsmith-channels";

const versionRange = ">=0.3.30 <1.0.0";

export const langSmithConfigs: InstrumentationConfig[] = [
  ...["dist/client.js", "dist/client.cjs"].flatMap((filePath) => [
    {
      channelName: langSmithChannels.createRun.channelName,
      module: { name: "langsmith", versionRange, filePath },
      functionQuery: {
        className: "Client",
        methodName: "createRun",
        kind: "Async" as const,
      },
    },
    {
      channelName: langSmithChannels.updateRun.channelName,
      module: { name: "langsmith", versionRange, filePath },
      functionQuery: {
        className: "Client",
        methodName: "updateRun",
        kind: "Async" as const,
      },
    },
    {
      channelName: langSmithChannels.batchIngestRuns.channelName,
      module: { name: "langsmith", versionRange, filePath },
      functionQuery: {
        className: "Client",
        methodName: "batchIngestRuns",
        kind: "Async" as const,
      },
    },
  ]),
];
