import type { InstrumentationConfig } from "../orchestrion-js";
import { strandsAgentSDKChannels } from "../../instrumentation/providers/strands-agent-sdk-interceptors";

const strandsAgentSDKVersionRange = ">=1.0.0 <2.0.0";

export const strandsAgentSDKConfigs: InstrumentationConfig[] = [
  {
    channelName: strandsAgentSDKChannels.agentStream.channelName,
    module: {
      name: "@strands-agents/sdk",
      versionRange: strandsAgentSDKVersionRange,
      filePath: "dist/src/agent/agent.js",
    },
    functionQuery: {
      className: "Agent",
      methodName: "stream",
    },
  },
  {
    channelName: strandsAgentSDKChannels.graphStream.channelName,
    module: {
      name: "@strands-agents/sdk",
      versionRange: strandsAgentSDKVersionRange,
      filePath: "dist/src/multiagent/graph.js",
    },
    functionQuery: {
      className: "Graph",
      methodName: "stream",
    },
  },
  {
    channelName: strandsAgentSDKChannels.swarmStream.channelName,
    module: {
      name: "@strands-agents/sdk",
      versionRange: strandsAgentSDKVersionRange,
      filePath: "dist/src/multiagent/swarm.js",
    },
    functionQuery: {
      className: "Swarm",
      methodName: "stream",
    },
  },
];
