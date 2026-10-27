import type { InstrumentationConfig } from "../orchestrion-js";
import {
  mcpSDKChannels,
  mcpServerChannels,
} from "../../instrumentation/plugins/mcp-interceptors";

const functionQuery = {
  className: "Protocol",
  methodName: "setRequestHandler",
};

export const mcpConfigs: InstrumentationConfig[] = [
  ...["dist/esm/shared/protocol.js", "dist/cjs/shared/protocol.js"].map(
    (filePath) => ({
      channelName: mcpSDKChannels.setRequestHandler.channelName,
      module: {
        name: "@modelcontextprotocol/sdk",
        versionRange: ">=1.2.0 <2.0.0",
        filePath,
      },
      functionQuery,
    }),
  ),
  // v2 bundles `Protocol` into a content-hashed chunk renamed on every release.
  ...["dist/src-*.mjs", "dist/src-*.cjs"].map((filePath) => ({
    channelName: mcpServerChannels.setRequestHandler.channelName,
    module: {
      name: "@modelcontextprotocol/server",
      versionRange: ">=2.0.0 <3.0.0",
      filePath,
    },
    functionQuery,
  })),
];
