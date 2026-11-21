import { channel, defineInterceptor } from "../core/interceptor-definitions";
import type { RetellArgs } from "../../vendor-sdk-types/retell";

export const retellChannels = defineInterceptor("retell-sdk", {
  createPhoneCall: channel<RetellArgs, PromiseLike<unknown>>({
    channelName: "call.createPhoneCall",
  }),
  createWebCall: channel<RetellArgs, PromiseLike<unknown>>({
    channelName: "call.createWebCall",
  }),
  retrieveCall: channel<RetellArgs, PromiseLike<unknown>>({
    channelName: "call.retrieve",
  }),
  createChat: channel<RetellArgs, PromiseLike<unknown>>({
    channelName: "chat.create",
  }),
  createChatCompletion: channel<RetellArgs, PromiseLike<unknown>>({
    channelName: "chat.createChatCompletion",
  }),
});
