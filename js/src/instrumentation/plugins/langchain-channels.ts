import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  LangChainCallbackManagerConfigureArgs,
  LangChainCallbackManagerConfigureResult,
} from "../../vendor-sdk-types/langchain";

export const langChainChannels = defineInterceptor("@langchain/core", {
  configure: channel<
    LangChainCallbackManagerConfigureArgs,
    LangChainCallbackManagerConfigureResult
  >({
    channelName: "CallbackManager.configure",
  }),
  configureSync: channel<
    LangChainCallbackManagerConfigureArgs,
    LangChainCallbackManagerConfigureResult
  >({
    channelName: "CallbackManager._configureSync",
  }),
});
