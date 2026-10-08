import type { NativeSpan } from "./runtime";
import type { RealtimeSession } from "./realtime";

/** Relevant LiveKit 1.9.x boundaries, vendored to avoid a runtime dependency. */
export interface AudioFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
}
export interface SpeechHandle {
  _agentTurnSpan?: NativeSpan;
}
export interface AgentSession {
  sessionSpan?: NativeSpan;
  activity?: AgentActivity;
  output?: { audio?: AudioOutput | null };
}
export interface AgentActivity {
  agentSession: AgentSession;
  currentSpeech?: SpeechHandle;
  realtimeSession?: RealtimeSession;
}
export interface AudioOutput {
  captureFrame(frame: AudioFrame): Promise<unknown>;
  flush(): unknown;
  clearBuffer(): unknown;
  on(event: string, callback: (...args: never[]) => void): unknown;
  off?(event: string, callback: (...args: never[]) => void): unknown;
}
export interface EndOfTurnInfo {
  userTurnSpan?: NativeSpan;
  startedSpeakingAt?: number;
  stoppedSpeakingAt?: number;
}
export interface ChatMessage {
  type: string;
  id: string;
  role?: string;
  textContent?: string;
  interrupted?: boolean;
}
