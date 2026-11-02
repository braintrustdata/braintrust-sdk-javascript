import type {
  AudioFrame,
  EndOfTurnInfo,
  ChatMessage,
  LiveKitSpan,
  TraceOptions,
  PipelineOptions,
  SpeechEvent,
} from "../../vendor-sdk-types/livekit";
import { channel, defineInterceptor } from "../core/interceptor-definitions";

export const livekitChannels = defineInterceptor("@livekit/agents", {
  startSpan: channel<[TraceOptions], LiveKitSpan>({
    channelName: "telemetry.startSpan",
  }),
  startActiveSpan: channel<
    [(span: LiveKitSpan) => Promise<unknown>, TraceOptions],
    Promise<unknown>
  >({ channelName: "telemetry.startActiveSpan" }),
  startActiveSpanSync: channel<
    [(span: LiveKitSpan) => unknown, TraceOptions],
    unknown
  >({ channelName: "telemetry.startActiveSpanSync" }),
  inference: channel<unknown[], unknown>({
    channelName: "generation.inference",
  }),
  conversation: channel<[ChatMessage], void>({
    channelName: "session.conversation",
  }),
  userCompleted: channel<[EndOfTurnInfo, unknown?], Promise<void>>({
    channelName: "activity.userCompleted",
  }),
  pipeline: channel<[PipelineOptions], Promise<void>>({
    channelName: "activity.pipeline",
  }),
  start: channel<[unknown], Promise<void>>({
    channelName: "session.start",
  }),
  close: channel<[string, unknown?, boolean?], Promise<void>>({
    channelName: "session.close",
  }),
  input: channel<[ReadableStream<AudioFrame>], void>({
    channelName: "activity.input",
  }),
  activity: channel<[unknown], Promise<void>>({
    channelName: "activity.start",
  }),
  userTurn: channel<[EndOfTurnInfo], Promise<boolean>>({
    channelName: "activity.userTurn",
  }),
  speechStart: channel<[unknown?], void>({
    channelName: "activity.speechStart",
  }),
  stt: channel<[SpeechEvent], void>({
    channelName: "recognition.stt",
  }),
});
