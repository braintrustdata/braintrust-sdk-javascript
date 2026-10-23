/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions -- vendored LiveKit boundaries. */
import type {
  AgentSession,
  AgentActivity,
  AudioFrame,
  AudioRecognition,
  AudioOutput,
  ChatMessage,
  EndOfTurnInfo,
  FunctionTool,
  LiveKitSpan,
  PlaybackFinishedEvent,
  PipelineOptions,
  PlaybackProgressedEvent,
  SpanTime,
  SpeechEvent,
  TraceOptions,
} from "../../vendor-sdk-types/livekit";
import iso from "../../isomorph";
import { BasePlugin } from "../core";
import { runInstrumentation } from "../core/observe-result";
import { livekitChannels } from "./livekit-interceptors";
import { v4 as uuidv4 } from "uuid";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { startSpan, withCurrent, type Span } from "../../logger";
import {
  withSpanInstrumentationName,
  INSTRUMENTATION_NAMES,
} from "../../span-origin";
import { isObject } from "../../../util";
import { zodToJsonSchema } from "../../zod/utils";
import { debugLogger } from "../../debug-logger";
import { isAutoCaptureAttachmentsEnabled } from "../../wrappers/attachment-utils";
import { DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES } from "../config";
import {
  PcmAudio,
  pcmBytesToMs,
  msToSamples,
  samplesToMs,
} from "../../pcm-audio";

// Bounds on per-session observation state, independent of the attachment threshold.
const MAX_ROWS = 8192;
const MAX_EVENTS = 256;
const MAX_RANGES = 100_000;
const MAX_RECORDING_MS = 30 * 60 * 1000;
const SAMPLE_RATE = 24000;
// The OTel API shares its context key through Symbol.for, including across copies.
const OTEL_SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
const FINAL_TRANSCRIPT = 2; // SpeechEventType.FINAL_TRANSCRIPT

// Native spans with a Braintrust name. Other session spans export as `livekit.<name>`.
const SPANS = new Map<string, { name: string; type: "task" | "llm" | "tool" }>([
  ["agent_session", { name: "session", type: "task" }],
  ["user_turn", { name: "user_turn", type: "task" }],
  ["agent_turn", { name: "agent_turn", type: "task" }],
  ["user_speaking", { name: "user_speech", type: "task" }],
  ["agent_speaking", { name: "agent_speech", type: "task" }],
  ["llm_node", { name: "llm_response", type: "llm" }],
  ["tts_node", { name: "tts", type: "task" }],
  ["function_tool", { name: "function_tool", type: "tool" }],
]);

const METRICS = {
  prompt_tokens: "gen_ai.usage.input_tokens",
  completion_tokens: "gen_ai.usage.output_tokens",
  cache_read_input_tokens: "gen_ai.usage.cache_read.input_tokens",
  cache_creation_input_tokens: "gen_ai.usage.cache_write.input_tokens",
  reasoning_tokens: "gen_ai.usage.reasoning.output_tokens",
  time_to_first_token: "contrib.livekit.response.ttft",
} as const;

export class LiveKitPlugin extends BasePlugin {
  private tracing?: LiveKitTracing;
  constructor(
    private streamingAttachmentBufferBytes = DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES,
  ) {
    super();
  }

  protected onEnable(): void {
    const tracing = (this.tracing = new LiveKitTracing(
      this.streamingAttachmentBufferBytes,
    ));
    const observeActive =
      <T>(fn: (span: LiveKitSpan) => T, options: TraceOptions) =>
      (span: LiveKitSpan) => {
        runInstrumentation(() => tracing.observeSpan(span, options));
        return tracing.scope(span, () => fn(span));
      };
    this.unsubscribers.push(
      livekitChannels.startSpan.intercept((target, self, args) => {
        const span = Reflect.apply(target, self, args);
        runInstrumentation(() => tracing.observeSpan(span, args[0]));
        return span;
      }),
      livekitChannels.startActiveSpan.intercept((target, self, [fn, options]) =>
        Reflect.apply(target, self, [observeActive(fn, options), options]),
      ),
      livekitChannels.startActiveSpanSync.intercept(
        (target, self, [fn, options]) =>
          Reflect.apply(target, self, [observeActive(fn, options), options]),
      ),
      livekitChannels.inference.intercept((target, self, args) =>
        tracing.inference(() => Reflect.apply(target, self, args)),
      ),
      livekitChannels.start.intercept((target, self, args) =>
        tracing.scope((self as AgentSession).sessionSpan, () =>
          Reflect.apply(target, self, args),
        ),
      ),
      livekitChannels.activity.intercept((target, self, args) => {
        const session = (self as AgentActivity).agentSession;
        runInstrumentation(() => tracing.output(session));
        return tracing.scope(session.sessionSpan, () =>
          Reflect.apply(target, self, args),
        );
      }),
      // Each reply re-checks the session's sink, so replaced outputs are observed.
      livekitChannels.pipeline.intercept((target, self, args) => {
        runInstrumentation(() =>
          tracing.output((self as AgentActivity).agentSession),
        );
        return tracing.scope(
          args[0].span,
          () => Reflect.apply(target, self, args),
          runInstrumentation(() => requestMetadata(args[0])) ?? {},
        );
      }),
      livekitChannels.conversation.intercept((target, self, args) => {
        runInstrumentation(() =>
          tracing.conversation(self as AgentSession, args[0]),
        );
        return Reflect.apply(target, self, args);
      }),
      livekitChannels.input.intercept((target, self, args) => {
        runInstrumentation(() => tracing.input(self as AgentActivity, args[0]));
        return Reflect.apply(target, self, args);
      }),
      livekitChannels.userTurn.intercept((target, self, args) => {
        runInstrumentation(() =>
          tracing.userTurn(self as AgentActivity, args[0]),
        );
        return Reflect.apply(target, self, args);
      }),
      livekitChannels.speechStart.intercept((target, self, args) =>
        tracing.scope(
          (self as AgentActivity).audioRecognition?.userTurnSpan,
          () => Reflect.apply(target, self, args),
        ),
      ),
      livekitChannels.stt.intercept((target, self, args) => {
        runInstrumentation(() =>
          tracing.stt(self as AudioRecognition, args[0]),
        );
        return Reflect.apply(target, self, args);
      }),
      livekitChannels.userCompleted.intercept((target, self, args) =>
        tracing.scope(args[0].userTurnSpan, () =>
          Reflect.apply(target, self, args),
        ),
      ),
      livekitChannels.close.intercept((target, self, args) =>
        tracing.close(self as AgentSession, () =>
          Reflect.apply(target, self, args),
        ),
      ),
    );
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    void this.tracing?.shutdown();
    this.tracing = undefined;
  }
}

type Row = {
  id: string;
  name: string;
  span: Span;
  /** Set when this native span folds into an exported ancestor. */
  owner?: Row;
  session: string;
  turn?: string;
  replyTo?: string;
  start: number;
  end?: number;
  ended: boolean;
  attributes: Map<string, unknown>;
  events: {
    name: string;
    time: number;
    attributes?: Record<string, unknown>;
  }[];
  status: { code: number; message?: string };
  playedText?: string;
  messages?: Map<string, string | undefined>;
};
type SessionState = {
  root: Row;
  /** Exported rows. Folded rows resolve through their owner. */
  rows: Map<string, Row>;
  rowLimitWarned: boolean;
  relationships: Relationships;
  speech: SpeechTracker;
  /** STT spans per user turn, for transcribed_by links. */
  transcripts: Map<string, { span: Span; end: number }[]>;
  recording?: Recording;
  playback?: Playback;
  closing?: Promise<void>;
  closed: boolean;
};

// Native no-op spans all share one OTel ID. Keep our observation identity
// separately without altering the application's span context or provider.
const observedRows = new WeakMap<object, Row>();
const observedId = (span: LiveKitSpan | undefined) =>
  span && observedRows.get(span)?.id;

class LiveKitTracing {
  // No-op OTel spans still need parent propagation across LiveKit's async work.
  // `inference` is shared by a scope and its unobserved children; it holds the
  // latest model response started there, which generated later speech.
  private context = iso.newAsyncLocalStorage<{
    native: LiveKitSpan;
    row?: Row;
    inference: { model?: Row };
    /** Tool configuration of the enclosing pipeline reply, for its llm spans. */
    request?: Record<string, unknown>;
  }>();
  readonly sessions = new Map<string, SessionState>();
  // Callbacks already handed to LiveKit can outlive interceptor unsubscription.
  private disabled = false;

  constructor(private streamingAttachmentBufferBytes: number) {}

  private rowOf(span: LiveKitSpan | undefined): Row | undefined {
    const row = span && observedRows.get(span);
    return row &&
      this.sessions.get(row.session)?.rows.has((row.owner ?? row).id)
      ? row
      : undefined;
  }
  private sessionOf(session: AgentSession): SessionState | undefined {
    return this.sessions.get(this.rowOf(session.sessionSpan)?.id ?? "");
  }

  /** Observe LiveKit's span API without installing or changing an OTel provider. */
  observeSpan(span: LiveKitSpan, options: TraceOptions): void {
    if (this.disabled || observedRows.has(span)) return;
    // LiveKit passes explicit OTel contexts for long-lived session/turn spans.
    const parent =
      (options.context?.getValue(OTEL_SPAN_KEY) as LiveKitSpan | undefined) ??
      this.context.getStore()?.native;
    const row = this.start(options, this.rowOf(parent));
    if (!row) return;
    observedRows.set(span, row);
    // Only model requests inside an llm_node contribute to their exported owner.
    // Leave other folded spans untouched, including their native recording state.
    if (
      row.owner &&
      (row.name !== "llm_request" || row.owner.name !== "llm_node")
    )
      return;
    const finish = () => this.end(row);
    const {
      isRecording,
      recordException,
      setAttribute,
      setAttributes,
      setStatus,
      addEvent,
      end,
    } = span;
    Object.assign(span, {
      // LiveKit only produces content and metrics for recording spans. Record its
      // lifecycle locally even when its OTel provider is a no-op or samples it out.
      isRecording(this: LiveKitSpan) {
        return !row.ended || isRecording.call(this);
      },
      recordException(this: LiveKitSpan, error: unknown, time?: SpanTime) {
        recordException.call(this, error, time);
        if (!row.ended) row.span.log({ error });
      },
      setAttribute(this: LiveKitSpan, key: string, value: unknown) {
        const result = setAttribute.call(this, key, value);
        if (!row.ended) row.attributes.set(key, value);
        return result;
      },
      setAttributes(this: LiveKitSpan, attributes: Record<string, unknown>) {
        const result = setAttributes.call(this, attributes);
        if (!row.ended)
          for (const [key, value] of Object.entries(attributes))
            row.attributes.set(key, value);
        return result;
      },
      setStatus(this: LiveKitSpan, status: { code: number; message?: string }) {
        const result = setStatus.call(this, status);
        if (!row.ended) row.status = { ...status };
        return result;
      },
      addEvent(
        this: LiveKitSpan,
        name: string,
        attributesOrTime?: Record<string, unknown> | SpanTime,
        time?: SpanTime,
      ) {
        const result = addEvent.call(this, name, attributesOrTime, time);
        if (!row.ended && row.events.length < MAX_EVENTS) {
          const attributes =
            isObject(attributesOrTime) && !(attributesOrTime instanceof Date)
              ? attributesOrTime
              : undefined;
          row.events.push({
            name,
            attributes,
            time: spanTimeSeconds(
              time ?? (attributes ? undefined : (attributesOrTime as SpanTime)),
            ),
          });
        }
        return result;
      },
      end(this: LiveKitSpan, time?: SpanTime) {
        const result = end.call(this, time);
        if (!row.ended) {
          row.ended = true;
          row.end = spanTimeSeconds(time);
          runInstrumentation(finish);
        }
        return result;
      },
    });
  }

  private start(options: TraceOptions, parent?: Row): Row | undefined {
    const name = options.name;
    const parentState = parent && this.sessions.get(parent.session);
    if (name !== "agent_session") {
      if (!parentState) return;
      if (parentState.rows.size >= MAX_ROWS) {
        if (!parentState.rowLimitWarned)
          debugLogger.warn(
            "LiveKit session exceeded its span limit; later native spans are not traced.",
          );
        parentState.rowLimitWarned = true;
        return;
      }
    }
    const kind = SPANS.get(name) ?? {
      name: `livekit.${name}`,
      type: "task" as const,
    };
    const start = spanTimeSeconds(options.startTime);
    // llm_request duplicates its model response lifecycle, so it folds into its parent.
    // Its attempts (llm_request_run) still export to show retries and failures.
    const owner =
      name === "llm_request" ? (parent!.owner ?? parent!) : undefined;
    const args =
      !owner &&
      withSpanInstrumentationName(
        { name: kind.name, type: kind.type, startTime: start },
        INSTRUMENTATION_NAMES.LIVEKIT,
      );
    const id = uuidv4();
    // Keep our own data, without retaining LiveKit's span or historical chat context.
    const row: Row = {
      id,
      name,
      span: !args
        ? owner!.span
        : parent
          ? parent.span.startSpan(args)
          : startSpan(args),
      owner,
      session: name === "agent_session" ? id : parent!.session,
      turn: name === "user_turn" || name === "agent_turn" ? id : parent?.turn,
      replyTo: parent?.replyTo,
      start,
      ended: false,
      attributes: new Map(Object.entries(options.attributes ?? {})),
      events: [],
      status: { code: 0 },
    };
    if (name === "agent_session") {
      const rows = new Map<string, Row>();
      const relationships = new Relationships();
      this.sessions.set(id, {
        root: row,
        rows,
        rowLimitWarned: false,
        relationships,
        speech: new SpeechTracker(relationships),
        transcripts: new Map(),
        recording: isAutoCaptureAttachmentsEnabled()
          ? new Recording(row.span, this.streamingAttachmentBufferBytes, (id) =>
              rows.get(id),
            )
          : undefined,
        closed: false,
      });
    }
    if (owner) return row;
    const state = this.sessions.get(row.session)!;
    state.rows.set(id, row);
    const scope = this.context.getStore();
    if (name === "user_speaking" || name === "agent_speaking")
      state.speech.add(row);
    if (name === "user_speaking")
      for (const stt of state.transcripts.get(row.turn ?? "") ?? [])
        state.relationships.link(row.span, stt.span, "transcribed_by");
    if (name === "llm_node" && scope) {
      scope.inference.model = row;
      if (scope.request) row.span.log({ metadata: scope.request });
    }
    if (
      (name === "tts_node" || name === "agent_speaking") &&
      scope?.inference.model
    )
      state.relationships.link(
        row.span,
        scope.inference.model.span,
        "generated_by",
      );
    const current = scope?.row?.session === row.session ? scope.row : undefined;
    if (name === "function_tool" && current?.name === "llm_node")
      state.relationships.link(row.span, current.span, "requested_by");
    if (name === "agent_turn" && current?.name === "user_turn")
      row.replyTo = current.span.spanId;
    if (row.turn || row.replyTo)
      row.span.log({
        metadata: {
          ...(row.turn
            ? { "turn.id": state.rows.get(row.turn)?.span.spanId }
            : {}),
          ...(row.replyTo ? { "turn.reply_to": row.replyTo } : {}),
        },
      });
    return row;
  }

  private end(row: Row): void {
    const attrs = nativeFields(row.attributes);
    const events = row.events;
    row.attributes = new Map();
    row.events = [];
    const state = this.sessions.get(row.session);
    if (!row.owner) {
      row.span.log(endEvent(row, attrs, events));
      if (state) correlate(row, attrs, state.relationships);
      if (row.name === "user_speaking")
        state?.recording?.selectInput(
          row.id,
          row.start * 1000,
          row.end! * 1000,
        );
      row.span.end({ endTime: row.end });
    } else {
      // Native request spans duplicate the public inference lifecycle.
      row.span.log(modelFields(attrs));
    }
    if (row.name === "agent_session") void this.closeSession(row.id);
    if (state?.closed) this.clearSession(row.session);
  }

  scope<T>(
    native: LiveKitSpan | undefined,
    fn: () => T,
    request?: Record<string, unknown>,
  ): T {
    if (!native) return fn();
    const found = this.rowOf(native);
    // Unobserved spans keep parenting local but inherit the enclosing session row.
    const outer = this.context.getStore();
    const row = found ? (found.owner ?? found) : outer?.row;
    const inference = found
      ? { model: found.name === "llm_node" ? found : undefined }
      : (outer?.inference ?? {});
    return this.context.run(
      { native, row, inference, request: request ?? outer?.request },
      () => (found ? withCurrent(row!.span, fn) : fn()),
    );
  }

  inference<T>(fn: () => T): T {
    // Only tracked sessions suppress duplicate provider spans. The suppressed
    // inference worker excludes the pipeline and user tools.
    return this.context.getStore()?.row
      ? runWithAutoInstrumentationSuppressed(fn)
      : fn();
  }

  /** LiveKit records STT only as user turn attributes; give each final transcript a span. */
  stt(recognition: AudioRecognition, event: SpeechEvent): void {
    const alternative = event.alternatives?.[0];
    if (event.type !== FINAL_TRANSCRIPT || !alternative?.text) return;
    const turn = this.rowOf(recognition.userTurnSpan);
    const parent =
      turn && !turn.ended
        ? turn
        : this.rowOf(
            recognition.rootSpanContext?.getValue(OTEL_SPAN_KEY) as
              | LiveKitSpan
              | undefined,
          );
    const state = parent && this.sessions.get(parent.session);
    if (!parent || !state) return;
    const transcripts =
      parent === turn ? (state.transcripts.get(turn.id) ?? []) : [];
    const end = event.createdAt ?? Date.now();
    // Providers without word timing (such as OpenAI STT) report startTime 0.
    const aligned =
      alternative.startTime && recognition.inputStartedAt !== undefined
        ? recognition.inputStartedAt + alternative.startTime * 1000
        : undefined;
    const start = Math.min(
      end,
      aligned ?? transcripts.at(-1)?.end ?? parent.start * 1000,
    );
    const { model = recognition.sttModel, provider = recognition.sttProvider } =
      recognition.sttIdentity?.() ?? {};
    const span = parent.span.startSpan(
      withSpanInstrumentationName(
        { name: "stt", type: "task" as const, startTime: start / 1000 },
        INSTRUMENTATION_NAMES.LIVEKIT,
      ),
    );
    span.log({
      output: [{ role: "user", content: alternative.text }],
      metadata: {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(alternative.confidence !== undefined
          ? { "contrib.livekit.transcript_confidence": alternative.confidence }
          : {}),
        ...(alternative.language
          ? { "contrib.livekit.language": alternative.language }
          : {}),
        ...(event.requestId
          ? { "contrib.livekit.provider_request_id": event.requestId }
          : {}),
        ...(parent.turn
          ? { "turn.id": state.rows.get(parent.turn)?.span.spanId }
          : {}),
      },
    });
    span.end({ endTime: end / 1000 });
    if (parent !== turn || transcripts.length >= MAX_EVENTS) return;
    transcripts.push({ span, end });
    state.transcripts.set(turn.id, transcripts);
    for (const row of state.rows.values())
      if (row.name === "user_speaking" && row.turn === turn.id)
        state.relationships.link(row.span, span, "transcribed_by");
  }

  conversation(session: AgentSession, item: ChatMessage): void {
    const state = this.sessionOf(session);
    if (item?.type !== "message" || !state) return;
    const current = this.context.getStore()?.row;
    const turn =
      (current?.session === state.root.id ? current.turn : undefined) ??
      (item.role === "assistant"
        ? this.rowOf(session.activity?.currentSpeech?._agentTurnSpan)?.id
        : undefined);
    // LiveKit falls back to the entire generated text on partial playback when
    // its output has no synchronized transcript. That fallback is not heard text.
    // A pipeline commit can include earlier fully played segments followed by the
    // synchronized partial suffix, so keep a verified prefix too.
    const heard = this.rowOf(session.agentSpeakingSpan)?.playedText;
    const textContent =
      item.role === "assistant" && item.interrupted
        ? heard && item.textContent?.endsWith(heard)
          ? item.textContent
          : heard
        : item.textContent;
    state.speech.message({ ...item, textContent }, turn);
  }

  input(activity: AgentActivity, stream: ReadableStream<AudioFrame>): void {
    this.sessionOf(activity.agentSession)?.recording?.attachInput(stream);
  }

  output(session: AgentSession): void {
    const state = this.sessionOf(session);
    const sink = session.output?.audio ?? undefined;
    if (!state || state.closing || state.playback?.sink === sink) return;
    state.playback?.close();
    state.playback = sink
      ? new Playback(
          sink,
          session,
          (text) => {
            const row = this.rowOf(session.agentSpeakingSpan);
            if (row) row.playedText = text;
          },
          state.recording,
        )
      : undefined;
  }

  userTurn(activity: AgentActivity, info: EndOfTurnInfo): void {
    const state = this.sessionOf(activity.agentSession);
    const turn = this.rowOf(info.userTurnSpan)?.id;
    const { startedSpeakingAt, stoppedSpeakingAt } = info;
    if (!state || !turn || startedSpeakingAt === undefined) return;
    state.speech.recognize(turn, startedSpeakingAt);
    // Native recognition speech boundaries share the local wall clock. Clip actual captured
    // samples; never derive selection from the broader user_turn span's start/end timestamps.
    if (stoppedSpeakingAt !== undefined)
      state.recording?.selectInput(turn, startedSpeakingAt, stoppedSpeakingAt);
  }

  /**
   * Runs LiveKit's close, then waits for the session's recording to upload and
   * publish. LiveKit's job process exits right after shutdown, so work left
   * running past close is lost. LiveKit's result and errors are unchanged.
   */
  async close(
    session: AgentSession,
    close: () => Promise<void>,
  ): Promise<void> {
    // closeImpl clears sessionSpan, so resolve the session before calling it.
    const span = session.sessionSpan;
    try {
      return await close();
    } finally {
      await this.closeSession(span);
    }
  }

  closeSession(session: LiveKitSpan | string | undefined): Promise<void> {
    const state = this.sessions.get(
      typeof session === "string" ? session : (this.rowOf(session)?.id ?? ""),
    );
    if (!state) return Promise.resolve();
    if (!state.closing) {
      state.playback?.close();
      state.playback = undefined;
      const done = () => {
        state.closed = true;
        this.clearSession(state.root.id);
      };
      state.closing = state.recording
        ? state.recording.finish().then(done)
        : Promise.resolve(done());
    }
    return state.closing;
  }

  private clearSession(id: string) {
    const state = this.sessions.get(id);
    // Native children (notably tools) can outlive session end. Retain ownership until
    // every mapped operation finishes, even after the recording has finalized.
    // Other native spans don't hold the session: LiveKit can leave them open.
    // Their rows still log and end on their own if LiveKit ends them later.
    if (
      !state ||
      [...state.rows.values()].some((row) => !row.ended && SPANS.has(row.name))
    )
      return;
    state.speech.finish(state.root.span);
    this.sessions.delete(id);
  }

  async shutdown(): Promise<void> {
    this.disabled = true;
    await Promise.all(
      [...this.sessions.keys()].map((id) => this.closeSession(id)),
    );
    for (const state of this.sessions.values()) {
      for (const row of state.rows.values()) {
        if (row.ended) continue;
        row.ended = true;
        row.span.log({
          metadata: {
            [row.turn === row.id
              ? "turn.incomplete"
              : "contrib.livekit.incomplete"]: true,
            "contrib.livekit.termination": "processor_shutdown",
          },
        });
        row.span.end();
      }
      state.speech.finish(state.root.span);
    }
    this.sessions.clear();
  }
}

function spanTimeSeconds(time: SpanTime = Date.now()): number {
  if (Array.isArray(time)) return time[0] + time[1] / 1e9;
  return (time instanceof Date ? time.getTime() : time) / 1000;
}
function nativeFields(fields: Iterable<[string, unknown]>) {
  return Object.fromEntries(
    [...fields].map(([key, value]) => [
      key.startsWith("lk.") ? `contrib.livekit.${key.slice(3)}` : key,
      value,
    ]),
  );
}
/** Drops content and duplicate vendor keys from native attributes. */
function metadataFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) =>
        !key.includes(".pii.") &&
        !key.startsWith("langfuse.") &&
        !/^gen_ai\.(input\.|output\.|system_instructions|tool\.(definitions|call\.(arguments|result)|description))/.test(
          key,
        ),
    ),
  );
}

function endEvent(
  row: Row,
  attrs: Record<string, unknown>,
  events: Row["events"],
) {
  const { metrics, metadata: model } = modelFields(attrs);
  const toolName = attrs["contrib.livekit.function_tool.name"];
  return {
    metadata: {
      ...metadataFields(attrs),
      ...(events.length
        ? {
            "contrib.livekit.events": events.map((event) => ({
              name: event.name,
              time_unix_ms: event.time * 1000,
              attributes: metadataFields(
                nativeFields(Object.entries(event.attributes ?? {})),
              ),
            })),
          }
        : {}),
      ...model,
    },
    ...(row.name === "llm_node" ? { metrics } : {}),
    ...(typeof toolName === "string"
      ? { span_attributes: { name: toolName, type: "tool" as const } }
      : {}),
    ...(row.status.code === 2
      ? { error: row.status.message ?? "LiveKit operation failed" }
      : {}),
    ...content(row.name, attrs),
  };
}

// LiveKit's native OTel payloads are JSON values, not OpenAI message objects.
// Normalize just the conversational surface; audio bytes are handled by Recording.
function content(name: string, attrs: Record<string, unknown>) {
  if (name === "llm_node") {
    const input = messages(attrs["contrib.livekit.pii.chat_ctx"]);
    const text = attrs["contrib.livekit.pii.response.text"];
    const calls = parse(attrs["contrib.livekit.pii.response.function_calls"]);
    const output = messages([
      ...(typeof text === "string" && text
        ? [{ role: "assistant", content: text }]
        : []),
      ...(Array.isArray(calls)
        ? calls.map((call) => ({ ...call, type: "function_call" }))
        : []),
    ]);
    return {
      ...(input ? { input } : {}),
      ...(output?.length ? { output } : {}),
    };
  }
  if (name === "tts_node") {
    const text = attrs["contrib.livekit.pii.input_text"];
    return typeof text === "string"
      ? { input: { text }, output: [{ role: "assistant", content: text }] }
      : {};
  }
  if (name === "function_tool")
    return {
      input: parse(attrs["contrib.livekit.pii.function_tool.arguments"]),
      output: parse(attrs["contrib.livekit.pii.function_tool.output"]),
    };
  return {};
}

// Tools are long-lived, so convert each parameter schema once.
const toolParameters = new WeakMap<FunctionTool, unknown>();

/** The tools and tool choice LiveKit makes available to one pipeline reply. */
function requestMetadata({ toolCtx, modelSettings }: PipelineOptions) {
  const tools = Object.entries(toolCtx?.functionTools ?? {}).map(
    ([name, tool]) => {
      if (!toolParameters.has(tool))
        toolParameters.set(
          tool,
          // LiveKit accepts zod object schemas or raw JSON schemas.
          isObject(tool.parameters) && "_def" in tool.parameters
            ? zodToJsonSchema(tool.parameters as any)
            : tool.parameters,
        );
      const parameters = toolParameters.get(tool);
      return {
        type: "function",
        function: {
          name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(parameters ? { parameters } : {}),
        },
      };
    },
  );
  const toolChoice = modelSettings?.toolChoice;
  return {
    ...(tools.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map(text).join("") : "";
}

type Message = {
  role: string;
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};
function messages(value: unknown): Message[] | undefined {
  const parsed = parse(value);
  const items = isObject(parsed) ? parsed.items : parsed;
  if (!Array.isArray(items)) return;
  return items.flatMap((item): Message[] => {
    if (!isObject(item)) return [];
    const callId = item.call_id;
    if (item.type === "function_call")
      return typeof callId === "string" && typeof item.name === "string"
        ? [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: callId,
                  type: "function",
                  function: {
                    name: item.name,
                    arguments: stringify(item.arguments),
                  },
                },
              ],
            },
          ]
        : [];
    if (item.type === "function_call_output")
      return typeof callId === "string"
        ? [
            {
              role: "tool",
              content: stringify(item.output),
              tool_call_id: callId,
            },
          ]
        : [];
    return typeof item.role === "string"
      ? [{ role: item.role, content: text(item.content) || null }]
      : [];
  });
}

function modelFields(attrs: Record<string, unknown>) {
  const metrics: Record<string, number> = {};
  for (const [target, source] of Object.entries(METRICS)) {
    const value = attrs[source];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      metrics[target] = value;
  }
  if (
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  )
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  const model = attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"];
  const provider = attrs["gen_ai.provider.name"];
  return {
    metrics,
    metadata: {
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof provider === "string" ? { provider } : {}),
    },
  };
}

/** Links native call, message, and tool identities between exported spans. */
function correlate(
  row: Row,
  attrs: Record<string, unknown>,
  relationships: Relationships,
) {
  const calls = parse(attrs["contrib.livekit.pii.response.function_calls"]);
  if (Array.isArray(calls))
    for (const call of calls)
      if (typeof call?.call_id === "string")
        relationships.register(`request:${call.call_id}`, row.span);
  const callId = attrs["gen_ai.tool.call.id"];
  if (row.name === "function_tool" && typeof callId === "string") {
    relationships.register(`tool:${callId}`, row.span);
    relationships.reference(row.span, `request:${callId}`, "requested_by");
  }
  if (row.name !== "llm_node") return;
  const context = parse(attrs["contrib.livekit.pii.chat_ctx"]);
  const items = isObject(context) ? context.items : undefined;
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (
      item?.type === "function_call_output" &&
      typeof item.call_id === "string"
    )
      relationships.reference(
        row.span,
        `tool:${item.call_id}`,
        "consumes_tool_result",
      );
    else if (item?.type === "message" && typeof item.id === "string")
      relationships.reference(row.span, `speech:${item.id}`, "input_context");
  }
}

type Relationship =
  | "input_context"
  | "requested_by"
  | "consumes_tool_result"
  | "generated_by"
  | "transcribed_by";
type Link = {
  context: { traceId: string; spanId: string; traceFlags: number };
  attributes: { "braintrust.relationship.type": Relationship };
};

/** Session-local identity resolution. A late transcript or tool can resolve an earlier link. */
class Relationships {
  private warned = false;
  private targets = new Map<string, Span>();
  private waiting = new Map<string, Map<Span, Relationship>>();
  private links = new Map<Span, Map<string, Link>>();

  register(id: string, target: Span): void {
    this.targets.set(id, target);
    for (const [source, relationship] of this.waiting.get(id) ?? [])
      this.link(source, target, relationship);
    this.waiting.delete(id);
  }

  reference(source: Span, id: string, relationship: Relationship): void {
    const target = this.targets.get(id);
    if (target) this.link(source, target, relationship);
    else if (this.waiting.size < MAX_ROWS) {
      const waiting = this.waiting.get(id) ?? new Map();
      waiting.set(source, relationship);
      this.waiting.set(id, waiting);
    }
  }

  link(source: Span, target: Span, relationship: Relationship): void {
    if (source.spanId === target.spanId) return;
    // Legacy UUID ID generators cannot be represented as OTel contexts. Do not
    // fabricate an identity that would point at a different exported span.
    if (
      !/^[0-9a-f]{32}$/.test(target.rootSpanId) ||
      !/^[0-9a-f]{16}$/.test(target.spanId) ||
      /^0+$/.test(target.rootSpanId) ||
      /^0+$/.test(target.spanId)
    ) {
      if (!this.warned)
        debugLogger.warn(
          "LiveKit span links require OpenTelemetry-compatible Braintrust IDs; disable BRAINTRUST_LEGACY_IDS.",
        );
      this.warned = true;
      return;
    }
    const links = this.links.get(source) ?? new Map<string, Link>();
    const key = `${relationship}:${target.rootSpanId}:${target.spanId}`;
    if (links.has(key)) return;
    links.set(key, {
      context: {
        traceId: target.rootSpanId,
        spanId: target.spanId,
        traceFlags: 1,
      },
      attributes: { "braintrust.relationship.type": relationship },
    });
    this.links.set(source, links);
    // Native rows have no top-level links field, and OTel ingestion does not keep
    // links yet. Metadata carries them until links are first-class.
    source.log({ metadata: { links: [...links.values()] } });
  }
}

/** Native speech owns transcripts; transcript arrival never changes its timing. */
class SpeechTracker {
  private rows: Row[] = [];
  private recognition = new Map<number, Row | undefined>();
  private owners = new Map<string, Row>();
  private pending = new Map<string, { item: ChatMessage; turn?: string }>();

  constructor(private relationships: Relationships) {}

  add(row: Row): void {
    this.rows.push(row);
    for (const { item, turn } of this.pending.values())
      if (item.metrics?.startedSpeakingAt !== undefined)
        this.message(item, turn);
  }

  recognize(turn: string, startedAt: number): void {
    const speech = this.rows.filter(
      (row) => row.name === "user_speaking" && row.turn === turn,
    );
    if (speech.length !== 1 || !Number.isFinite(startedAt)) return;
    const start = startedAt / 1000;
    this.recognition.set(
      start,
      !this.recognition.has(start) || this.recognition.get(start) === speech[0]
        ? speech[0]
        : undefined,
    );
  }

  finish(root: Span): void {
    if (this.pending.size)
      root.log({
        metadata: {
          "contrib.livekit.unassociated_messages": [
            ...this.pending.values(),
          ].map(({ item }) => ({
            id: item.id,
            role: item.role,
            text: item.textContent,
            started_speaking_at: item.metrics?.startedSpeakingAt,
          })),
        },
      });
  }

  message(item: ChatMessage, turn?: string): void {
    if (item.role !== "user" && item.role !== "assistant") return;
    // Keep only transcript observations, never ChatMessage audio/context payloads.
    item = {
      type: item.type,
      id: item.id,
      role: item.role,
      textContent: item.textContent,
      interrupted: item.interrupted,
      metrics: item.metrics && {
        startedSpeakingAt: item.metrics.startedSpeakingAt,
      },
    };
    const name = item.role === "user" ? "user_speaking" : "agent_speaking";
    const start = item.metrics?.startedSpeakingAt;
    const candidates = this.rows.filter((row) => {
      if (row.name !== name) return false;
      if (start !== undefined && Number.isFinite(start))
        return (
          start >= row.start - 0.001 &&
          (row.end === undefined || start <= row.end + 0.001)
        );
      if (turn) return row.turn === turn;
      // A user message can be typed input. Do not assign it to old audio.
      return item.role === "assistant" && !row.ended;
    });
    const row =
      this.owners.get(item.id) ??
      (item.role === "user" && start !== undefined
        ? this.recognition.get(start)
        : undefined) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!row) {
      if (this.pending.size < MAX_ROWS)
        this.pending.set(item.id, { item, turn });
      return;
    }
    this.pending.delete(item.id);
    this.owners.set(item.id, row);
    this.relationships.register(`speech:${item.id}`, row.span);
    const messages = (row.messages ??= new Map());
    messages.set(item.id, item.textContent);
    row.span.log({
      ...(item.textContent !== undefined
        ? {
            [item.role === "user" ? "input" : "output"]: [...messages.values()]
              .filter((content) => content !== undefined)
              .map((content) => ({ role: item.role, content })),
          }
        : {}),
      metadata: {
        "contrib.livekit.message_ids": [...messages.keys()],
        ...(item.interrupted ? { "contrib.livekit.interrupted": true } : {}),
      },
    });
  }
}

type Packet = {
  pcm: Int16Array;
  rate: number;
  channels: number;
  channel: number;
  /** Session-clock offset in milliseconds; relative to its run while staged. */
  at: number;
};
type Interval = { start: number; end: number; channel: number };
type AudioFile = {
  id: string;
  start: number;
  end: number;
  channels: number[];
  metadata: NonNullable<ReturnType<PcmAudio["digest"]>>["metadata"];
  state: "pending" | "ready" | "omitted";
  reason?: string;
};

const inputs = new WeakMap<object, Recording>();
const sinks = new WeakMap<object, Playback>();

/** LiveKit's call clock, upload queue, and speech-to-file references. PcmAudio owns the bytes. */
class Recording {
  readonly origin = Date.now();
  /** Session-clock playout that each pending output run may still add audio before. */
  readonly holds = new Map<object, number>();
  private pcm: PcmAudio;
  private files: AudioFile[] = [];
  private formats = [
    new Map<string, { sample_rate_hz: number; channel_count: number }>(),
    new Map<string, { sample_rate_hz: number; channel_count: number }>(),
  ];
  private selections = new Map<string, Interval[]>();
  private playbackEvents = new Map<string, unknown[]>();
  private confirmedThroughMs = 0;
  private stagedBytes = 0;
  private inputStream?: object;
  private inputStart?: number;
  private inputEnd?: number;
  private job?: Promise<void>;
  private finishing?: Promise<void>;
  reason?: string;
  closed = false;

  constructor(
    private span: Span,
    private chunkBytes: number,
    private resolve: (owner: string) => Row | undefined,
  ) {
    this.pcm = new PcmAudio({
      sampleRate: SAMPLE_RATE,
      channels: 2,
      maxBufferBytes: Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(32 * 1024 * 1024, 2 * chunkBytes),
      ),
    });
  }

  get active(): boolean {
    return !this.closed && !this.reason;
  }
  stop(reason: string): void {
    this.reason ??= reason;
  }

  /** Validates a LiveKit frame, returning its samples while capture continues. */
  private samples(frame: AudioFrame): Int16Array | undefined {
    if (!this.active) return;
    if (
      !(frame?.data instanceof Int16Array) ||
      !Number.isInteger(frame.sampleRate) ||
      frame.sampleRate < 8000 ||
      frame.sampleRate > 96000 ||
      ![1, 2].includes(frame.channels) ||
      frame.data.length % frame.channels
    ) {
      this.stop("unsupported_frame_format");
      return;
    }
    return frame.data.length ? frame.data : undefined;
  }

  record(packet: Packet): boolean {
    if (!this.active) return false;
    const durationMs = pcmBytesToMs(
      packet.pcm.byteLength,
      packet.rate,
      packet.channels,
    );
    if (packet.at + durationMs > MAX_RECORDING_MS) {
      this.stop("duration_limit");
      return false;
    }
    const bytes =
      Math.round(
        ((packet.pcm.length / packet.channels) * SAMPLE_RATE) / packet.rate,
      ) * 2;
    if (
      this.pcm.bufferedByteLength + this.stagedBytes + bytes >
      this.pcm.maxBufferBytes
    ) {
      this.stop("capture_byte_limit");
      return false;
    }
    try {
      this.pcm.update(packet.pcm, {
        sampleRate: packet.rate,
        channels: packet.channels,
        channel: packet.channel,
        offsetMs: packet.at,
      });
    } catch (error) {
      this.stop(error instanceof Error ? error.message : "capture_failed");
      return false;
    }
    this.formats[packet.channel].set(`${packet.rate}:${packet.channels}`, {
      sample_rate_hz: packet.rate,
      channel_count: packet.channels,
    });
    return true;
  }

  /** Copies an output frame until playout confirms or discards it. */
  stage(frame: AudioFrame): Int16Array | undefined {
    const data = this.samples(frame);
    if (!data) return;
    if (
      this.stagedBytes + this.pcm.bufferedByteLength + data.byteLength >
      this.pcm.maxBufferBytes
    ) {
      this.stop("capture_byte_limit");
      return;
    }
    this.stagedBytes += data.byteLength;
    // LiveKit may reuse the frame while captureFrame is awaiting the sink.
    return data.slice();
  }
  unstage(pcm: Int16Array): void {
    this.stagedBytes -= pcm.byteLength;
  }

  attachInput(stream: ReadableStream<AudioFrame>): void {
    if (!this.active || typeof stream?.getReader !== "function") return;
    if (this.inputStream && this.inputStream !== stream) {
      this.stop("input_source_change_unsupported");
      return;
    }
    const previous = inputs.get(stream);
    if (previous && previous !== this && !previous.closed) {
      previous.stop("shared_input_unsupported");
      this.stop("shared_input_unsupported");
      return;
    }
    this.inputStream = stream;
    inputs.set(stream, this);
    tapInput(stream);
  }

  recordInput(frame: AudioFrame): void {
    const pcm = this.samples(frame);
    if (!pcm) return;
    const duration = pcmBytesToMs(
      pcm.byteLength,
      frame.sampleRate,
      frame.channels,
    );
    // This input is an ordered PCM stream, including silent samples. Anchor
    // once to the session epoch; scheduler jitter is not missing audio.
    // Source replacement is rejected rather than joining unrelated clocks.
    const at =
      this.inputEnd ?? Math.max(0, Date.now() - this.origin - duration);
    if (
      !this.record({
        pcm,
        rate: frame.sampleRate,
        channels: frame.channels,
        channel: 0,
        at,
      })
    )
      return;
    this.inputStart ??= at;
    this.inputEnd = at + duration;
    this.advance();
  }

  /** Select captured input between two wall-clock times for a span. */
  selectInput(owner: string, fromUnixMs: number, toUnixMs: number): void {
    if (
      this.inputStart === undefined ||
      !Number.isFinite(fromUnixMs) ||
      !Number.isFinite(toUnixMs)
    )
      return;
    this.select(
      owner,
      Math.max(this.inputStart, fromUnixMs - this.origin),
      Math.min(this.inputEnd!, toUnixMs - this.origin),
      0,
    );
    this.publish([owner]);
  }

  select(owner: string, start: number, end: number, channel: number): void {
    if (!(end > start)) return;
    const list = this.selections.get(owner) ?? [];
    const previous = list.at(-1);
    if (
      previous &&
      previous.channel === channel &&
      start >= previous.start &&
      start <= previous.end + samplesToMs(1)
    ) {
      previous.end = Math.max(previous.end, end);
      return;
    }
    if (list.length >= MAX_RANGES) {
      this.stop("selection_limit");
      return;
    }
    list.push({ start, end, channel });
    this.selections.set(owner, list);
  }

  playbackEvent(owner: string, event: unknown): void {
    const events = this.playbackEvents.get(owner) ?? [];
    if (events.length < MAX_EVENTS) events.push(event);
    this.playbackEvents.set(owner, events);
  }

  /** Only cut where neither input nor a queued playback run can still add audio. */
  advance(): void {
    const wall = Date.now() - this.origin - 1000;
    this.confirmedThroughMs = Math.max(
      this.confirmedThroughMs,
      Math.min(
        wall,
        this.inputStream ? (this.inputEnd ?? 0) : wall,
        ...this.holds.values(),
      ),
    );
    this.upload();
  }

  finish(): Promise<void> {
    return (this.finishing ??= (async () => {
      this.closed = true;
      this.upload();
      while (this.job) await this.job;
      this.publishFiles();
    })());
  }

  private upload(): void {
    if (
      this.job ||
      !this.pcm.bufferedByteLength ||
      (this.reason && !this.closed)
    )
      return;
    const id = `call-${String(this.files.length).padStart(4, "0")}`;
    let result: ReturnType<PcmAudio["digest"]>;
    try {
      result = this.pcm.digest({
        maxBytes: this.chunkBytes,
        endOffsetMs: this.closed
          ? undefined
          : Math.min(this.confirmedThroughMs, this.pcm.endOffsetMs),
        flush: this.closed,
        filename: `${id}.pcm`,
      });
    } catch (error) {
      this.stop(
        error instanceof Error ? error.message : "recording_export_failed",
      );
      return;
    }
    if (!result) return;
    const { attachment } = result;
    const file: AudioFile = {
      id,
      start: result.startOffsetMs,
      end: result.endOffsetMs,
      channels: result.channels,
      metadata: result.metadata,
      state: "pending",
    };
    this.files.push(file);
    this.publishFiles();
    // One ordinary SDK attachment upload at a time; capture continues into the next digest.
    this.job = (async () => {
      try {
        const status = await attachment.upload();
        file.state = status.upload_status === "done" ? "ready" : "omitted";
      } catch {
        file.state = "omitted";
      }
      if (file.state === "ready") {
        this.span.log({ input: { audio: { [id]: attachment.reference } } });
      } else {
        file.reason = "recording_export_failed";
        this.stop(file.reason);
      }
      this.publishFiles();
      if (file.state === "ready")
        this.publish(
          [...this.selections]
            .filter(([, list]) =>
              list.some((s) => s.start < file.end && s.end > file.start),
            )
            .map(([owner]) => owner),
        );
    })().finally(() => {
      this.job = undefined;
      this.upload();
    });
  }

  private publishFiles(): void {
    const recordings: Record<string, unknown>[] = this.files.map((f) => ({
      id: f.id,
      recording_group_id: "call",
      state: f.state,
      ...(f.reason ? { reason: f.reason } : {}),
      ...(f.state === "ready"
        ? {
            attachment: {
              span_id: this.span.spanId,
              ref: `/input/audio/${f.id}`,
            },
            ...f.metadata,
          }
        : {}),
      sources: f.channels.map((channel_index) => ({
        channel_index,
        boundary: channel_index === 0 ? "session_input" : "local_audio_output",
      })),
      timeline: {
        origin_unix_ms: this.origin,
        basis: "local_input_arrival_and_output_playout",
        recording_start_offset_ms: f.start,
      },
      ...(f.state === "omitted"
        ? {
            gaps: [
              {
                start_offset_ms: f.start,
                end_offset_ms: f.end,
                reason: f.reason,
              },
            ],
          }
        : {}),
    }));
    if (this.reason)
      recordings.push({
        id: "call",
        recording_group_id: "call",
        state: "omitted",
        reason: this.reason,
        truncated: true,
      });
    else if (!recordings.length && this.closed)
      recordings.push({
        id: "call",
        recording_group_id: "call",
        state: "omitted",
        reason: "no_audio_observed",
      });
    this.span.log({
      metadata: {
        "audio.recordings": recordings,
        "contrib.livekit.audio.input_formats": [...this.formats[0].values()],
        "contrib.livekit.audio.output_formats": [...this.formats[1].values()],
      },
    });
  }

  /** Publish each owner's selections within the files uploaded so far. */
  publish(owners: Iterable<string>): void {
    const ready = this.files.filter((f) => f.state === "ready");
    const toSample = (ms: number) => samplesToMs(Math.round(msToSamples(ms)));
    for (const owner of owners) {
      const row = this.resolve(owner);
      const intervals = this.selections.get(owner);
      if (!row || row.owner || !intervals) continue;
      const events = this.playbackEvents.get(owner);
      row.span.log({
        metadata: {
          "audio.selections": ready.flatMap((f) =>
            intervals
              .map((s) => ({
                recording_span_id: this.span.spanId,
                recording_id: f.id,
                channel_index: s.channel,
                start_offset_ms: Math.max(0, toSample(s.start - f.start)),
                end_offset_ms: Math.min(
                  f.end - f.start,
                  toSample(s.end - f.start),
                ),
              }))
              .filter((s) => s.end_offset_ms > s.start_offset_ms),
          ),
          ...(events ? { "contrib.livekit.playback_events": events } : {}),
        },
      });
    }
  }
}

// Tap the reader already requested by LiveKit. No tee, prefetch, or extra consumer.
// Keeping the original stream lets LiveKit release/reacquire its lock on handoff.
function tapInput(stream: any) {
  const marker = Symbol.for("braintrust.livekit.input");
  if (stream[marker]) return;
  Object.defineProperty(stream, marker, { value: true });
  const getReader = stream.getReader;
  stream.getReader = function (this: unknown, ...args: unknown[]) {
    const reader: ReadableStreamDefaultReader<AudioFrame> = Reflect.apply(
      getReader,
      this,
      args,
    );
    const read = reader.read;
    reader.read = async function (this: unknown, ...readArgs: unknown[]) {
      const result: ReadableStreamReadResult<AudioFrame> = await Reflect.apply(
        read,
        this,
        readArgs,
      );
      if (!result.done)
        runInstrumentation(() => inputs.get(stream)?.recordInput(result.value));
      return result;
    };
    return reader;
  };
}

// The sink keeps its patch for later sessions and routes to its current owner.
function patchSink(sink: any) {
  const marker = Symbol.for("braintrust.livekit.output");
  if (sink[marker]) return;
  Object.defineProperty(sink, marker, { value: true });
  const { captureFrame, flush, clearBuffer } = sink;
  sink.captureFrame = function (this: unknown, ...args: [AudioFrame]) {
    const call = (): Promise<void> => Reflect.apply(captureFrame, this, args);
    const playback = sinks.get(sink);
    return playback ? playback.capture(args[0], call) : call();
  };
  sink.flush = function (this: unknown, ...args: []) {
    sinks.get(sink)?.endRun();
    return Reflect.apply(flush, this, args);
  };
  sink.clearBuffer = function (this: unknown, ...args: []) {
    sinks.get(sink)?.endRun();
    return Reflect.apply(clearBuffer, this, args);
  };
}

type Run = {
  /** Accepted frames awaiting playout confirmation, positioned within the run. */
  frames: Packet[];
  duration: number;
  /** The agent_turn and agent_speaking rows this playout belongs to. */
  owner?: string;
  speaking?: string;
  /** Played ranges recorded before the speaking row is known. */
  unclaimed: { start: number; end: number }[];
  started?: number;
  ranges: PlaybackProgressedEvent[];
  finished?: PlaybackFinishedEvent;
  inFlight: number;
  processed: number;
  hadProgress: boolean;
};

/** One session's audio sink: heard transcripts and, when recording, confirmed playout. */
class Playback {
  private runs: Run[] = [];
  private current?: Run;
  private listeners: [string, (event: any) => void][];
  private recording?: Recording;

  constructor(
    readonly sink: AudioOutput,
    private session: AgentSession,
    private heard: (text: string | undefined) => void,
    recording?: Recording,
  ) {
    this.listeners = [
      [
        "playbackFinished",
        (event) => runInstrumentation(() => this.finished(event)),
      ],
    ];
    const previous = recording && sinks.get(sink);
    if (previous?.recording) {
      previous.recording.stop("shared_output_unsupported");
      recording!.stop("shared_output_unsupported");
    } else if (recording) {
      this.recording = recording;
      sinks.set(sink, this);
      patchSink(sink);
      this.listeners.push(
        [
          "playbackStarted",
          (event) =>
            runInstrumentation(() => {
              if (this.runs[0]) this.runs[0].started = event.createdAt;
            }),
        ],
        [
          "playbackProgressed",
          (event) => runInstrumentation(() => this.progressed(event)),
        ],
      );
    }
    for (const [event, listener] of this.listeners)
      sink.on(event as "playbackFinished", listener);
  }

  close(): void {
    for (const [event, listener] of this.listeners)
      this.sink.off(event, listener);
    if (!this.recording) return;
    if (this.runs.some((run) => run.frames.length))
      this.recording.stop("unfinished_output_segment");
    for (const run of this.runs.splice(0)) this.discard(run);
    this.current = undefined;
    sinks.delete(this.sink);
  }

  endRun(): void {
    this.current = undefined;
  }

  async capture(frame: AudioFrame, call: () => Promise<void>): Promise<void> {
    const recording = this.recording!;
    let run: Run | undefined;
    let pcm: Int16Array | undefined;
    let queued = false;
    runInstrumentation(() => {
      if (!recording.active) return;
      run = this.current ??= this.startRun();
      run.inFlight++;
      pcm = recording.stage(frame);
    });
    try {
      const result = await call();
      runInstrumentation(() => {
        if (!run || !pcm || !recording.active) return;
        queued = true;
        run.frames.push({
          pcm,
          rate: frame.sampleRate,
          channels: frame.channels,
          channel: 1,
          at: run.duration,
        });
        run.duration += pcmBytesToMs(
          pcm.byteLength,
          frame.sampleRate,
          frame.channels,
        );
      });
      return result;
    } catch (error) {
      runInstrumentation(() => recording.stop("output_capture_failed"));
      throw error;
    } finally {
      runInstrumentation(() => {
        if (run) {
          run.inFlight--;
          this.settle(run);
        }
        if (pcm && !queued) recording.unstage(pcm);
      });
    }
  }

  private startRun(): Run {
    const run: Run = {
      frames: [],
      duration: 0,
      owner: observedId(this.session.activity?.currentSpeech?._agentTurnSpan),
      unclaimed: [],
      ranges: [],
      inFlight: 0,
      processed: 0,
      hadProgress: false,
    };
    this.runs.push(run);
    this.recording!.holds.set(
      run,
      Math.max(0, Date.now() - this.recording!.origin - 1000),
    );
    return run;
  }

  private progressed(event: PlaybackProgressedEvent): void {
    const run = this.runs[0];
    if (!run) return;
    if (run.ranges.length >= MAX_RANGES) {
      this.recording!.stop("playout_range_limit");
      return;
    }
    run.hadProgress = true;
    run.ranges.push({
      startedAt: event.startedAt,
      offset: event.offset,
      duration: event.duration,
    });
    this.settle(run);
  }

  private finished(event: PlaybackFinishedEvent): void {
    this.heard(
      typeof event.synchronizedTranscript === "string"
        ? event.synchronizedTranscript
        : undefined,
    );
    const run = this.recording && this.runs.find((r) => !r.finished);
    if (!run) return;
    run.finished = event;
    this.settle(run);
  }

  private discard(run: Run): void {
    for (const frame of run.frames.splice(0))
      this.recording!.unstage(frame.pcm);
    this.recording!.holds.delete(run);
  }

  /** Map confirmed playout ranges onto staged frames, recording only heard audio. */
  private settle(run: Run): void {
    const recording = this.recording!;
    const { finished } = run;
    if (
      run.inFlight ||
      (!finished && !run.ranges.length) ||
      !this.runs.includes(run)
    )
      return;
    if (finished) {
      this.runs.splice(this.runs.indexOf(run), 1);
      if (this.current === run) this.current = undefined;
    }
    if (!recording.active) return this.discard(run);
    run.speaking ??= observedId(this.session.agentSpeakingSpan);
    if (run.speaking)
      for (const played of run.unclaimed.splice(0))
        recording.select(run.speaking, played.start, played.end, 1);
    const ranges = run.ranges.splice(0);
    if (finished && !run.hadProgress) {
      // Sinks without progress events confirm one contiguous run from its start.
      if (run.started !== undefined && !finished.interrupted)
        ranges.push({
          startedAt: run.started,
          offset: 0,
          duration: Math.min(run.duration, finished.playbackPosition * 1000),
        });
      else if (run.duration) {
        recording.stop("output_playout_mapping_unavailable");
        return this.discard(run);
      }
    }
    for (const range of ranges) {
      if (
        ![range.startedAt, range.offset, range.duration].every(
          Number.isFinite,
        ) ||
        range.offset < run.processed - samplesToMs(1) ||
        range.duration < 0
      ) {
        recording.stop("invalid_playout_range");
        break;
      }
      const end = range.offset + range.duration;
      for (const frame of run.frames) {
        const frameEnd =
          frame.at +
          pcmBytesToMs(frame.pcm.byteLength, frame.rate, frame.channels);
        const from = Math.max(frame.at, range.offset);
        const to = Math.min(frameEnd, end);
        if (to <= from) continue;
        const pcm = frame.pcm.subarray(
          Math.round(msToSamples(from - frame.at, frame.rate)) * frame.channels,
          Math.round(msToSamples(to - frame.at, frame.rate)) * frame.channels,
        );
        const at = Math.max(
          0,
          range.startedAt - recording.origin + from - range.offset,
        );
        if (!recording.record({ ...frame, pcm, at })) continue;
        const played = {
          start: at,
          end: at + pcmBytesToMs(pcm.byteLength, frame.rate, frame.channels),
        };
        if (run.owner) recording.select(run.owner, played.start, played.end, 1);
        if (run.speaking)
          recording.select(run.speaking, played.start, played.end, 1);
        else if (run.unclaimed.length < MAX_RANGES) run.unclaimed.push(played);
        else recording.stop("selection_limit");
      }
      run.processed = end;
      // Only confirmed output advances this hold. Generated/queued audio never does.
      recording.holds.set(
        run,
        Math.max(0, range.startedAt - recording.origin + range.duration),
      );
    }
    run.frames = run.frames.filter((frame) => {
      const consumed =
        finished ||
        !recording.active ||
        frame.at +
          pcmBytesToMs(frame.pcm.byteLength, frame.rate, frame.channels) <=
          run.processed + samplesToMs(1);
      if (consumed) recording.unstage(frame.pcm);
      return !consumed;
    });
    if (finished) {
      recording.holds.delete(run);
      if (run.owner)
        recording.playbackEvent(run.owner, {
          name: "playbackFinished",
          time_unix_ms: Date.now(),
          attributes: {
            playbackPosition: finished.playbackPosition,
            interrupted: finished.interrupted,
            ...(finished.synchronizedTranscript !== undefined
              ? { synchronizedTranscript: finished.synchronizedTranscript }
              : {}),
          },
        });
      recording.publish(
        [run.owner, run.speaking].filter((id): id is string => !!id),
      );
    }
    recording.advance();
  }
}

export const _exportsForTestingOnly = {
  LiveKitTracing,
  Recording,
  Playback,
  requestMetadata,
};
