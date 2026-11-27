import type { InstrumentationConfig } from "../orchestrion-js";
import { agentKitChannels } from "../../instrumentation/providers/agent-kit-interceptors";

// Validate new published layouts before extending this range or chunk path.
export const agentKitConfigs: InstrumentationConfig[] = [
  "dist/chunk-BSWKEFTT.js",
  "dist/index.cjs",
].flatMap((filePath) => [
  ...(
    [
      ["Agent", "run", agentKitChannels.agentRun],
      ["Agent", "invokeTools", agentKitChannels.prepareTools],
      ["Network", "run", agentKitChannels.networkRun],
      ["AgenticModel", "infer", agentKitChannels.infer],
      ["NetworkRun", "getNextAgents", agentKitChannels.route],
    ] as const
  ).map(([className, methodName, hook]) => ({
    channelName: hook.channelName,
    module: { name: "@inngest/agent-kit", versionRange: "=0.13.2", filePath },
    functionQuery: { className, methodName },
  })),
  {
    channelName: agentKitChannels.createTool.channelName,
    module: { name: "@inngest/agent-kit", versionRange: "=0.13.2", filePath },
    functionQuery: { functionName: "createTool" },
  },
]);
