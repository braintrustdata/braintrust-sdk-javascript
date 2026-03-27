import { channel, defineChannels } from "../core/channel-definitions";
import type {
  AnthropicBatchCreateParams,
  AnthropicBatchListParams,
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicMessageBatch,
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
  messagesBatchesCreate: channel<
    [AnthropicBatchCreateParams],
    AnthropicMessageBatch,
    Record<string, unknown>
  >({
    channelName: "messages.batches.create",
    kind: "async",
  }),
  messagesBatchesRetrieve: channel<
    [string],
    AnthropicMessageBatch,
    Record<string, unknown>
  >({
    channelName: "messages.batches.retrieve",
    kind: "async",
  }),
  messagesBatchesList: channel<
    [AnthropicBatchListParams?],
    unknown,
    Record<string, unknown>
  >({
    channelName: "messages.batches.list",
    kind: "async",
  }),
  messagesBatchesCancel: channel<
    [string],
    AnthropicMessageBatch,
    Record<string, unknown>
  >({
    channelName: "messages.batches.cancel",
    kind: "async",
  }),
  messagesBatchesDelete: channel<[string], unknown, Record<string, unknown>>({
    channelName: "messages.batches.delete",
    kind: "async",
  }),
});
