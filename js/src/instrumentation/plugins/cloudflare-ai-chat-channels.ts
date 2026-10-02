import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  CloudflareAIChatResponseResult,
  CloudflareAIChatTurnCallback,
  CloudflareAIChatTurnOptions,
} from "../../vendor-sdk-types/cloudflare-ai-chat";

type CloudflareAIChatChannelContext = {
  self?: unknown;
};

export const cloudflareAIChatChannels = defineInterceptor(
  "@cloudflare/ai-chat",
  {
    runExclusiveChatTurn: channel<
      [string, CloudflareAIChatTurnCallback, CloudflareAIChatTurnOptions?],
      PromiseLike<unknown>,
      CloudflareAIChatChannelContext
    >({
      channelName: "AIChatAgent._runExclusiveChatTurn",
    }),

    onChatResponse: channel<
      [CloudflareAIChatResponseResult],
      unknown,
      CloudflareAIChatChannelContext
    >({
      channelName: "AIChatAgent.onChatResponse",
    }),
  },
);
