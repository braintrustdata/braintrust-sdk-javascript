import type { InstrumentationConfig } from "../orchestrion-js";
import { piCodingAgentChannels } from "../../instrumentation/plugins/pi-coding-agent-interceptors";

const piCodingAgentVersionRange = ">=0.79.0 <2.0.0";

export const piCodingAgentConfigs: InstrumentationConfig[] = [
  {
    channelName: piCodingAgentChannels.prompt.channelName,
    module: {
      name: "@earendil-works/pi-coding-agent",
      versionRange: piCodingAgentVersionRange,
      filePath: "dist/core/agent-session.js",
    },
    functionQuery: {
      className: "AgentSession",
      methodName: "prompt",
    },
  },
];
