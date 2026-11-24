import type {
  AudioFrame,
  EndOfTurnInfo,
  LiveKitSpan,
  TraceOptions,
  PipelineOptions,
  SpeechEvent,
  SpeechEndEvent,
  VadInferenceEvent,
  EouWaitOptions,
  AgentActivity,
} from "../../vendor-sdk-types/livekit";
import { channel, defineInterceptor } from "../core/interceptor-definitions";

export const livekitChannels = defineInterceptor("@livekit/agents", {
  modelEnqueue: channel<[unknown], unknown, { stream: object }>({
    channelName: "model.enqueue",
  }),
  modelRun: channel<unknown[], unknown>({ channelName: "model.run" }),
  model: channel<
    unknown[],
    unknown,
    {
      kind: "llm" | "stt" | "tts";
      method: string;
      activity: AgentActivity;
    }
  >({ channelName: "model.call" }),
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
  sessionEvent: channel<[string, ...unknown[]], boolean>({
    channelName: "session.emit",
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

/** Public OpenAI adapter constructors, separate from Agents invocation hooks. */
export const livekitOpenAIChannels = defineInterceptor(
  "@livekit/agents-plugin-openai",
  {
    llm: channel<unknown[], object>({ channelName: "llm.construct" }),
    stt: channel<unknown[], object>({ channelName: "stt.construct" }),
    tts: channel<unknown[], object>({ channelName: "tts.construct" }),
  },
);
