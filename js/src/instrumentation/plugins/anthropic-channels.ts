import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  CompleteAnthropicBatchTraceArgs,
  BindAnthropicBatchTraceArgs,
  FailAnthropicBatchTraceArgs,
  AnthropicBatchLike,
  StartAnthropicBatchTraceArgs,
  StartAnthropicBatchTraceResult,
} from "../../anthropic-batch-types";
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
type AnthropicBindTraceResult = { traceContext?: string };

export const anthropicChannels = defineChannels(
  "@anthropic-ai/sdk",
  {
    batchesStartTrace: channel<
      [StartAnthropicBatchTraceArgs],
      StartAnthropicBatchTraceResult
    >({
      channelName: "messages.batches.start-trace",
      kind: "async",
    }),
    batchesCompleteTrace: channel<
      [CompleteAnthropicBatchTraceArgs],
      AnthropicBatchLike
    >({
      channelName: "messages.batches.complete-trace",
      kind: "async",
    }),
    batchesBindTrace: channel<
      [BindAnthropicBatchTraceArgs],
      AnthropicBindTraceResult
    >({
      channelName: "messages.batches.bind-trace",
      kind: "async",
    }),
    batchesFailTrace: channel<[FailAnthropicBatchTraceArgs], void>({
      channelName: "messages.batches.fail-trace",
      kind: "async",
    }),
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
