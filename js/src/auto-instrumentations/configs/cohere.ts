import type { InstrumentationConfig } from "../orchestrion-js";
import { cohereChannels } from "../../instrumentation/providers/cohere-interceptors";

// Keep major-version ranges separate to preserve prerelease matching.
export const cohereConfigs: InstrumentationConfig[] = (
  ["chat", "chatStream", "embed", "rerank"] as const
).flatMap((methodName) =>
  [
    {
      className: "CohereClient",
      filePath: "Client.js",
      versionRange: ">=7.0.0 <8.0.0 || >=8.0.0 <9.0.0",
    },
    {
      className: "V2",
      filePath: "api/resources/v2/client/Client.js",
      versionRange: ">=7.0.0 <7.21.0",
    },
    {
      className: "V2Client",
      filePath: "api/resources/v2/client/Client.js",
      versionRange: ">=7.21.0 <8.0.0 || >=8.0.0 <9.0.0",
    },
  ].map(({ className, filePath, versionRange }) => ({
    channelName: cohereChannels[methodName].channelName,
    module: { name: "cohere-ai", filePath, versionRange },
    functionQuery: { className, methodName },
  })),
);
