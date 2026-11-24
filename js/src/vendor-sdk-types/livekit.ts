/** Relevant LiveKit 1.9.x–1.10.x boundaries, vendored to avoid a runtime dependency. */
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
  llm?: ModelService;
  stt?: ModelService;
  tts?: ModelService;
  agent?: Agent;
  agentSession: AgentSession;
  /** The VAD in use: the agent's own, else the session's (LiveKit provides a default). */
  vad?: unknown;
  /** How LiveKit detects turns; "stt" lets the STT provider's speech events drive them. */
  turnDetectionMode?: string;
  audioRecognition?: AudioRecognition;
  currentSpeech?: SpeechHandle;
}
/** Relevant service surface shared by LiveKit's cascade adapters. */
export interface ModelService {
  [method: string]: unknown;
  model?: string;
  provider?: string;
  client?: unknown;
  capabilities?: { streaming?: boolean };
}
export interface AudioRecognition {
  eouWaitSpan?: LiveKitSpan;
  stt?: unknown;
  audioTranscript?: string;
  vadBaseTurnDetection?: boolean;
  sttPipeline?: { manualFlush?: boolean };
  sttFlushRequested?: boolean;
  closed?: boolean;
  userTurnSpan?: LiveKitSpan;
  rootSpanContext?: { getValue(key: symbol): unknown };
  inputStartedAt?: number;
  lastSpeakingTime?: number;
  vad?: unknown;
  turnDetectionMode?: string;
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
    endTime?: number;
    /** A diarizing STT's label for the voice, scoped to its input. */
    speakerId?: string | null;
  }[];
  requestId?: string;
  createdAt?: number;
  /** Absolute observed speech end, in Unix milliseconds. */
  speechEndTime?: number;
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
  /** Whether LiveKit can pause playout on this sink (and those it forwards to). */
  readonly canPause?: boolean;
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
/** Only the VAD timing fields observed by instrumentation. Durations are ms. */
export interface SpeechEndEvent {
  type: number;
  silenceDuration: number;
  inferenceDuration: number;
}
export interface VadInferenceEvent {
  rawAccumulatedSpeech: number;
}
export interface EouWaitOptions {
  trigger: string;
  lastSpeakingTime: number | undefined;
  endpointingDelay: number;
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
  /** LiveKit's metrics report, in seconds; a user message's turn timing. */
  metrics?: {
    startedSpeakingAt?: number;
    stoppedSpeakingAt?: number;
    onUserTurnCompletedDelay?: number;
  };
}

export interface LiveKitSpan {
  /** OTel SDK spans' attributes, including those span processors set at start. */
  attributes?: Record<string, unknown>;
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
  /** The user message this reply answers, when a user turn prompted it. */
  newMessage?: ChatMessage;
  toolCtx?: { functionTools: Record<string, FunctionTool> };
  modelSettings?: { toolChoice?: unknown };
}
/** LiveKit's per-job context; it carries the LiveKit Cloud project's redaction setting. */
export interface JobContext {
  _redactionEnabled?: boolean;
}
export interface LiveKitModule {
  voice: { AgentSession: new (...args: unknown[]) => AgentSession };
  telemetry: { tracer: LiveKitTracer };
  getJobContext?: (required?: boolean) => JobContext | undefined;
}

/** Declared protected plugin extension points on LiveKit's model streams.
 * No public event exposes attempt-local partial output before the shared queue.
 */
export interface ModelWorker {
  run?: unknown;
  queue?: { put?: unknown };
}

/** Public constructor options shared by the OpenAI cascade adapters. */
export interface OpenAIAdapterOptions {
  client?: unknown;
}
export interface LiveKitOpenAIPlugin {
  LLM: new (...args: unknown[]) => ModelService;
  STT: new (...args: unknown[]) => ModelService;
  TTS: new (...args: unknown[]) => ModelService;
}
