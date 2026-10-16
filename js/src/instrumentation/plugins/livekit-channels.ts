import type { AudioFrame, EndOfTurnInfo, ChatMessage } from "../livekit/types";
import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
export const livekitChannels = defineChannels(
  "@livekit/agents",
  {
    trace: channel<unknown[], unknown>({
      channelName: "telemetry.trace",
      kind: "sync-stream",
    }),
    provider: channel<unknown[], unknown>({
      channelName: "telemetry.provider",
      kind: "sync-stream",
    }),
    inference: channel<unknown[], unknown>({
      channelName: "generation.inference",
      kind: "sync-stream",
    }),
    conversation: channel<[ChatMessage], unknown>({
      channelName: "session.conversation",
      kind: "sync-stream",
    }),
    userCompleted: channel<[EndOfTurnInfo, unknown?], unknown>({
      channelName: "activity.userCompleted",
      kind: "async",
    }),
    pipeline: channel<unknown[], unknown>({
      channelName: "activity.pipeline",
      kind: "async",
    }),
    realtime: channel<unknown[], unknown>({
      channelName: "activity.realtime",
      kind: "async",
    }),
    start: channel<unknown[], unknown>({
      channelName: "session.start",
      kind: "async",
    }),
    close: channel<unknown[], unknown>({
      channelName: "session.close",
      kind: "async",
    }),
    input: channel<[ReadableStream<AudioFrame>], unknown>({
      channelName: "activity.input",
      kind: "sync-stream",
    }),
    output: channel<unknown[], unknown>({
      channelName: "session.output",
      kind: "sync-stream",
    }),
    activity: channel<unknown[], unknown>({
      channelName: "activity.start",
      kind: "async",
    }),
    userTurn: channel<[EndOfTurnInfo], unknown>({
      channelName: "activity.userTurn",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.LIVEKIT },
);
