import type { InstrumentationConfig } from "../orchestrion-js";
import { cloudflareAIChatChannels } from "../../instrumentation/plugins/cloudflare-ai-chat-channels";

const cloudflareAIChatVersionRange = ">=0.9.0 <0.10.0";

export const cloudflareAIChatConfigs: InstrumentationConfig[] = [
  {
    // AIChatAgent subclasses replace onChatMessage, so there is no stable
    // public implementation for the transformer to target. This runner is
    // the narrowest shared boundary around every chat turn; keep the version
    // range tight because it is an internal method.
    channelName: cloudflareAIChatChannels.runExclusiveChatTurn.channelName,
    module: {
      name: "@cloudflare/ai-chat",
      versionRange: cloudflareAIChatVersionRange,
      filePath: "dist/index.js",
    },
    functionQuery: {
      className: "AIChatAgent",
      methodName: "_runExclusiveChatTurn",
      kind: "Async",
    },
  },
];
