import type { InstrumentationConfig } from "../orchestrion-js";
import { liveKitAgentsChannels } from "../../instrumentation/plugins/livekit-agents-channels";

const versionRange = ">=1.5.0 <2.0.0";
const nodes = [
  ["sttNode", liveKitAgentsChannels.defaultSttNode],
  ["llmNode", liveKitAgentsChannels.defaultLlmNode],
  ["ttsNode", liveKitAgentsChannels.defaultTtsNode],
] as const;

export const liveKitAgentsConfigs = ["js", "cjs"].flatMap(
  (extension): InstrumentationConfig[] => {
    const agentModule = {
      name: "@livekit/agents",
      versionRange,
      filePath: `dist/voice/agent.${extension}`,
    };
    return [
      ...nodes.flatMap(([methodName, defaultChannel]) => [
        {
          channelName: liveKitAgentsChannels[methodName].channelName,
          module: agentModule,
          functionQuery: {
            className: "Agent",
            methodName,
            kind: "Async" as const,
          },
        },
        {
          channelName: defaultChannel.channelName,
          module: agentModule,
          // Agent.default is a static class field containing an object literal.
          astQuery: `PropertyDefinition[key.name="default"] Property[key.name="${methodName}"] > FunctionExpression`,
          functionQuery: { methodName, kind: "Async" as const },
        },
      ]),
      {
        channelName: liveKitAgentsChannels.tool.channelName,
        module: {
          name: "@livekit/agents",
          versionRange,
          filePath: `dist/llm/tool_context.${extension}`,
        },
        functionQuery: { functionName: "tool", kind: "Sync" },
      },
    ];
  },
);
