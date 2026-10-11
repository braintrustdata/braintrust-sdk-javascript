import type { InstrumentationConfig } from "../orchestrion-js";
import { portkeyChannels } from "../../instrumentation/plugins/portkey-channels";

export const portkeyConfigs: InstrumentationConfig[] = [
  {
    channelName: portkeyChannels.chatCompletionsCreate.channelName,
    module: {
      name: "portkey-ai",
      versionRange: ">=3.0.0 <4.0.0",
      filePath: "dist/src/apis/chatCompletions.js",
    },
    functionQuery: {
      className: "ChatCompletions",
      methodName: "create",
      kind: "Async",
    },
  },
];
