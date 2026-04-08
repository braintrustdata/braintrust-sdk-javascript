import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
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
