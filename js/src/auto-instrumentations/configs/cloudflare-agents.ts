import type { InstrumentationConfig } from "../orchestrion-js";
import { cloudflareAgentsChannels } from "../../instrumentation/providers/cloudflare-agents-interceptors";

const cloudflareAgentsVersionRange = ">=0.17.0 <0.18.0";

export const cloudflareAgentsConfigs: InstrumentationConfig[] = [
  {
    channelName: cloudflareAgentsChannels.runAgentTool.channelName,
    module: {
      name: "agents",
      versionRange: cloudflareAgentsVersionRange,
      filePath: "dist/index.js",
    },
    functionQuery: {
      className: "Agent",
      methodName: "runAgentTool",
    },
  },
  {
    channelName: cloudflareAgentsChannels.runAgentTool.channelName,
    module: {
      name: "agents",
      versionRange: ">=0.32.0 <0.34.0",
      // Agent moved from the entrypoint into a hashed shared chunk in 0.32.
      filePath: "dist/src-*.js",
    },
    functionQuery: {
      className: "Agent",
      methodName: "runAgentTool",
    },
  },
];
