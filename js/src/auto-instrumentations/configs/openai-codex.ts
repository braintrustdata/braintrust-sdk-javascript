import type { InstrumentationConfig } from "../orchestrion-js";
import { openAICodexChannels } from "../../instrumentation/providers/openai-codex-interceptors";

const openAICodexVersionRange = ">=0.128.0 <1.0.0";

export const openAICodexConfigs: InstrumentationConfig[] = [
  {
    channelName: openAICodexChannels.run.channelName,
    module: {
      name: "@openai/codex-sdk",
      versionRange: openAICodexVersionRange,
      filePath: "dist/index.js",
    },
    functionQuery: {
      className: "Thread",
      methodName: "run",
    },
  },
  {
    channelName: openAICodexChannels.runStreamed.channelName,
    module: {
      name: "@openai/codex-sdk",
      versionRange: openAICodexVersionRange,
      filePath: "dist/index.js",
    },
    functionQuery: {
      className: "Thread",
      methodName: "runStreamed",
    },
  },
];
