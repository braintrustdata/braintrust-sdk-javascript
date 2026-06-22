import type { InstrumentationConfig } from "../orchestrion-js";
import { openRouterAgentChannels } from "../../instrumentation/plugins/openrouter-agent-channels";

export const openRouterAgentConfigs: InstrumentationConfig[] = [
  {
    channelName: openRouterAgentChannels.callModel.channelName,
    module: {
      name: "@openrouter/agent",
      versionRange: ">=0.1.2",
      filePath: "esm/inner-loop/call-model.js",
    },
    functionQuery: {
      functionName: "callModel",
      kind: "Sync",
    },
  },
];
