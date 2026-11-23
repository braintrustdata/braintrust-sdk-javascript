import type {
  AudioFrame,
  EndOfTurnInfo,
  ChatMessage,
  LiveKitSpan,
  TraceOptions,
  PipelineOptions,
  SpeechEvent,
  SpeechEndEvent,
  VadInferenceEvent,
  EouWaitOptions,
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
  vadInference: channel<[VadInferenceEvent], void>({
    channelName: "activity.vadInference",
  }),
  speechEnd: channel<[SpeechEndEvent?], void>({
    channelName: "activity.speechEnd",
  }),
  recognitionClose: channel<[], Promise<void>>({
    channelName: "recognition.close",
  }),
  eouWait: channel<[LiveKitSpan, EouWaitOptions], LiveKitSpan>({
    channelName: "recognition.eouWait",
  }),
  eouEvaluation: channel<[unknown, string?], void>({
    channelName: "recognition.eouEvaluation",
  }),
  eouEnd: channel<[string, number?], void>({
    channelName: "recognition.eouEnd",
  }),
  stt: channel<[SpeechEvent], void>({
    channelName: "recognition.stt",
  }),
  jobContext: channel<[boolean?], unknown>({
    channelName: "job.context",
  }),
});
