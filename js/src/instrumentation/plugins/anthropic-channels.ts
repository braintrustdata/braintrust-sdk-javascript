import { channel, defineChannels } from "../core";
import type {
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicStreamEvent,
} from "../../vendor-sdk-types/anthropic";

type AnthropicResult = AnthropicMessage | AsyncIterable<AnthropicStreamEvent>;

export const anthropicChannels = defineChannels({
  messagesCreate: channel<
    [AnthropicCreateParams],
    AnthropicResult,
    Record<string, never>,
    AnthropicStreamEvent
  >({
    name: "messages.create",
    fullName: "orchestrion:@anthropic-ai/sdk:messages.create",
    kind: "async",
  }),
  betaMessagesCreate: channel<
    [AnthropicCreateParams],
    AnthropicResult,
    Record<string, never>,
    AnthropicStreamEvent
  >({
    name: "beta.messages.create",
    fullName: "orchestrion:@anthropic-ai/sdk:beta.messages.create",
    kind: "async",
  }),
});
