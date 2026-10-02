import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicMessageStream,
  AnthropicSessionEvent,
  AnthropicSessionEventStream,
  AnthropicSessionEventStreamParams,
  AnthropicSessionThreadEventStreamParams,
  AnthropicStreamEvent,
  AnthropicToolRunner,
  AnthropicToolRunnerParams,
} from "../../vendor-sdk-types/anthropic";

type AnthropicResult = AnthropicMessage | AnthropicMessageStream;

export const anthropicChannels = defineInterceptor("@anthropic-ai/sdk", {
  messagesCreate: channel<
    [AnthropicCreateParams],
    PromiseLike<AnthropicResult>,
    Record<string, unknown>,
    AnthropicStreamEvent
  >({
    channelName: "messages.create",
  }),
  betaMessagesCreate: channel<
    [AnthropicCreateParams],
    PromiseLike<AnthropicResult>,
    Record<string, unknown>,
    AnthropicStreamEvent
  >({
    channelName: "beta.messages.create",
  }),
  betaMessagesToolRunner: channel<
    [AnthropicToolRunnerParams],
    AnthropicToolRunner<unknown>
  >({
    channelName: "beta.messages.toolRunner",
  }),
  betaSessionsEventsStream: channel<
    [string, AnthropicSessionEventStreamParams?],
    PromiseLike<AnthropicSessionEventStream>,
    Record<string, unknown>,
    AnthropicSessionEvent
  >({
    channelName: "beta.sessions.events.stream",
  }),
  betaSessionsThreadsEventsStream: channel<
    [string, AnthropicSessionThreadEventStreamParams],
    PromiseLike<AnthropicSessionEventStream>,
    Record<string, unknown>,
    AnthropicSessionEvent
  >({
    channelName: "beta.sessions.threads.events.stream",
  }),
});
