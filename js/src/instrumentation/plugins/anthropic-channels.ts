import { channel, defineChannels } from "../core/channel-definitions";
import type {
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicStreamEvent,
} from "../../vendor-sdk-types/anthropic";

type AnthropicResult = AnthropicMessage | AsyncIterable<AnthropicStreamEvent>;

export const anthropicChannels = defineChannels("@anthropic-ai/sdk", {
  messagesCreate: channel<
    [AnthropicCreateParams],
    AnthropicResult,
    Record<string, unknown>,
    AnthropicStreamEvent
  >({
    channelName: "messages.create",
    kind: "async",
  }),
  betaMessagesCreate: channel<
    [AnthropicCreateParams],
    AnthropicResult,
    Record<string, unknown>,
    AnthropicStreamEvent
  >({
    channelName: "beta.messages.create",
    kind: "async",
  }),
});
