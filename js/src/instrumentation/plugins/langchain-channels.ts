import { channel, defineChannels } from "../core/channel-definitions";
import type {
  LangChainCallbackManagerConfigureArgs,
  LangChainCallbackManagerConfigureResult,
} from "../../vendor-sdk-types/langchain";

export const langChainChannels = defineChannels("@langchain/core", {
  configure: channel<
    LangChainCallbackManagerConfigureArgs,
    LangChainCallbackManagerConfigureResult
  >({
    channelName: "CallbackManager.configure",
    kind: "sync-stream",
  }),
  configureSync: channel<
    LangChainCallbackManagerConfigureArgs,
    LangChainCallbackManagerConfigureResult
  >({
    channelName: "CallbackManager._configureSync",
    kind: "sync-stream",
  }),
});
