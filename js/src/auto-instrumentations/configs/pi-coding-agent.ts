import type { InstrumentationConfig } from "../orchestrion-js";
import { piCodingAgentChannels } from "../../instrumentation/plugins/pi-coding-agent-channels";

const piCodingAgentVersionRange = ">=0.79.0 <0.80.0";

export const piCodingAgentOrchestrionConfigs: InstrumentationConfig[] = [
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
      kind: "Async",
    },
  },
];
