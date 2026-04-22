import { channel, defineChannels } from "../core/channel-definitions";
import type { LangChainCallbackManagerConfigureResult } from "../../vendor-sdk-types/langchain";

export const langChainChannels = defineChannels("@langchain/core", {
  configure: channel<unknown[], LangChainCallbackManagerConfigureResult>({
    channelName: "CallbackManager.configure",
    kind: "sync-stream",
  }),
  configureSync: channel<unknown[], LangChainCallbackManagerConfigureResult>({
    channelName: "CallbackManager._configureSync",
    kind: "sync-stream",
  }),
});
