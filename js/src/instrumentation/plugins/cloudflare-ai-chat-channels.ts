import { channel, defineChannels } from "../core/channel-definitions";
import type {
  CloudflareAIChatResponseResult,
  CloudflareAIChatTurnCallback,
  CloudflareAIChatTurnOptions,
} from "../../vendor-sdk-types/cloudflare-ai-chat";

type CloudflareAIChatChannelContext = {
  self?: unknown;
};

export const cloudflareAIChatChannels = defineChannels("@cloudflare/ai-chat", {
  runExclusiveChatTurn: channel<
    [string, CloudflareAIChatTurnCallback, CloudflareAIChatTurnOptions?],
    unknown,
    CloudflareAIChatChannelContext
  >({
    channelName: "AIChatAgent._runExclusiveChatTurn",
    kind: "async",
  }),

  onChatResponse: channel<
    [CloudflareAIChatResponseResult],
    unknown,
    CloudflareAIChatChannelContext
  >({
    channelName: "AIChatAgent.onChatResponse",
    kind: "sync-stream",
  }),
});
