import type { InstrumentationConfig } from "../orchestrion-js";
import { cloudflareAgentsChannels } from "../../instrumentation/plugins/cloudflare-agents-channels";

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
      kind: "Async",
    },
  },
];
