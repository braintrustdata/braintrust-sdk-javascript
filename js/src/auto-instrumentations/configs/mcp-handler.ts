import type { InstrumentationConfig } from "../orchestrion-js";
import { mcpHandlerChannels } from "../../instrumentation/plugins/mcp-handler-interceptors";

export const mcpHandlerConfigs: InstrumentationConfig[] = [
  "dist/index.mjs",
  "dist/index.js",
].map((filePath) => ({
  channelName: mcpHandlerChannels.createMcpHandler.channelName,
  module: {
    name: "mcp-handler",
    versionRange: ">=1.0.0 <3.0.0",
    filePath,
  },
  // The public createMcpHandler export uses this name in both ESM and CJS builds.
  functionQuery: { functionName: "createMcpRouteHandler" },
}));
