import type { InstrumentationConfig } from "../orchestrion-js";
import { fastMCPChannels } from "../../instrumentation/plugins/fastmcp-interceptors";

export const fastMCPConfigs: InstrumentationConfig[] = [
  // FastMCP publishes its session class in content-hashed ESM/CJS chunks.
  ...["dist/chunk-*.js", "dist/chunk-*.cjs"].map((filePath) => ({
    channelName: fastMCPChannels.sessionConnect.channelName,
    module: {
      name: "fastmcp",
      versionRange: ">=3.35.0 <5.0.0",
      filePath,
    },
    functionQuery: { className: "FastMCPSession", methodName: "connect" },
  })),
];
