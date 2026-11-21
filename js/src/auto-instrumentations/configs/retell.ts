import type { InstrumentationConfig } from "../orchestrion-js";
import { retellChannels } from "../../instrumentation/providers/retell-interceptors";

export const retellConfigs: InstrumentationConfig[] = ["js", "mjs"].flatMap(
  (extension) =>
    (
      [
        ["call", "Call", "createPhoneCall", retellChannels.createPhoneCall],
        ["call", "Call", "createWebCall", retellChannels.createWebCall],
        ["call", "Call", "retrieve", retellChannels.retrieveCall],
        ["chat", "Chat", "create", retellChannels.createChat],
        [
          "chat",
          "Chat",
          "createChatCompletion",
          retellChannels.createChatCompletion,
        ],
      ] as const
    ).map(([resource, className, methodName, hook]) => ({
      channelName: hook.channelName,
      module: {
        name: "retell-sdk",
        versionRange: ">=6.2.22 <7.0.0",
        filePath: `resources/${resource}.${extension}`,
      },
      functionQuery: { className, methodName },
    })),
);
