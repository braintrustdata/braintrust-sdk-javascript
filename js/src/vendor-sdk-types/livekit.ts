/** Relevant LiveKit 1.9.x boundaries, vendored to avoid a runtime dependency. */
export interface AudioFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
}
export interface SpeechHandle {
  _agentTurnSpan?: LiveKitSpan;
}
export interface AgentSession {
  sessionSpan?: LiveKitSpan;
  agentSpeakingSpan?: LiveKitSpan;
  activity?: AgentActivity;
  output?: { audio?: AudioOutput | null };
}
export interface AgentActivity {
  agent?: Agent;
  agentSession: AgentSession;
  audioRecognition?: AudioRecognition;
  currentSpeech?: SpeechHandle;
}
export interface AudioRecognition {
  userTurnSpan?: LiveKitSpan;
  rootSpanContext?: { getValue(key: symbol): unknown };
  inputStartedAt?: number;
  sttModel?: string;
  sttProvider?: string;
  sttIdentity?: () => { model?: string; provider?: string } | undefined;
}
export interface SpeechEvent {
  type: number;
  alternatives?: {
    text: string;
    confidence?: number;
    language?: string;
    startTime?: number;
  }[];
  requestId?: string;
  createdAt?: number;
}
export interface PlaybackStartedEvent {
  createdAt: number;
}
export interface PlaybackProgressedEvent {
  startedAt: number;
  offset: number;
  duration: number;
}
export interface PlaybackFinishedEvent {
  playbackPosition: number;
  interrupted: boolean;
  synchronizedTranscript?: string;
}
export interface AudioOutput {
  captureFrame(frame: AudioFrame): Promise<void>;
  flush(): void;
  clearBuffer(): void;
  on(
    event: "playbackStarted",
    callback: (ev: PlaybackStartedEvent) => void,
  ): unknown;
  on(
    event: "playbackProgressed",
    callback: (ev: PlaybackProgressedEvent) => void,
  ): unknown;
  on(
    event: "playbackFinished",
    callback: (ev: PlaybackFinishedEvent) => void,
  ): unknown;
  off(event: string, callback: (...args: never[]) => void): unknown;
}
export interface EndOfTurnInfo {
  userTurnSpan?: LiveKitSpan;
  startedSpeakingAt?: number;
  stoppedSpeakingAt?: number;
}
export interface ChatMessage {
  type: string;
  id: string;
  role?: string;
  textContent?: string;
  interrupted?: boolean;
  metrics?: { startedSpeakingAt?: number };
}

export interface LiveKitSpan {
  isRecording(): boolean;
  spanContext(): { spanId: string };
  setAttribute(key: string, value: unknown): this;
  setAttributes(attributes: Record<string, unknown>): this;
  setStatus(status: { code: number; message?: string }): this;
  recordException(error: unknown, time?: SpanTime): void;
  addEvent(
    name: string,
    attributesOrTime?: Record<string, unknown> | SpanTime,
    time?: SpanTime,
  ): this;
  end(time?: SpanTime): void;
}
export type SpanTime = number | Date | [number, number];
export interface TraceOptions {
  name: string;
  attributes?: Record<string, unknown>;
  startTime?: SpanTime;
  context?: { getValue(key: symbol): unknown };
}
export interface LiveKitTracer {
  startSpan(options: TraceOptions): LiveKitSpan;
  startActiveSpan<T>(
    fn: (span: LiveKitSpan) => Promise<T>,
    options: TraceOptions,
  ): Promise<T>;
  startActiveSpanSync<T>(
    fn: (span: LiveKitSpan) => T,
    options: TraceOptions,
  ): T;
}
export interface Agent {
  llmNode(...args: unknown[]): unknown;
  ttsNode(...args: unknown[]): unknown;
}
export interface FunctionTool {
  description?: string;
  parameters?: unknown;
}
export interface PipelineOptions {
  span: LiveKitSpan;
  toolCtx?: { functionTools: Record<string, FunctionTool> };
  modelSettings?: { toolChoice?: unknown };
}
export interface LiveKitModule {
  voice: { AgentSession: new (...args: unknown[]) => AgentSession };
  telemetry: { tracer: LiveKitTracer };
}
