import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { strandsAgentSDKChannels } from "../../instrumentation/plugins/strands-agent-sdk-channels";

const strandsAgentSDKVersionRange = ">=1.0.0 <2.0.0";

export const strandsAgentSDKOrchestrionConfigs: InstrumentationConfig[] = [
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
      kind: "Sync",
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
      kind: "Sync",
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
      kind: "Sync",
    },
  },
];
