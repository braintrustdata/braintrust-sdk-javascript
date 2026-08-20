import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
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

export const anthropicChannels = defineChannels(
  "@anthropic-ai/sdk",
  {
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
    betaMessagesToolRunner: channel<
      [AnthropicToolRunnerParams],
      AnthropicToolRunner<unknown>
    >({
      channelName: "beta.messages.toolRunner",
      kind: "sync-stream",
    }),
    betaSessionsEventsStream: channel<
      [string, AnthropicSessionEventStreamParams?],
      AnthropicSessionEventStream,
      Record<string, unknown>,
      AnthropicSessionEvent
    >({
      channelName: "beta.sessions.events.stream",
      kind: "async",
    }),
    betaSessionsThreadsEventsStream: channel<
      [string, AnthropicSessionThreadEventStreamParams],
      AnthropicSessionEventStream,
      Record<string, unknown>,
      AnthropicSessionEvent
    >({
      channelName: "beta.sessions.threads.events.stream",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.ANTHROPIC },
);
