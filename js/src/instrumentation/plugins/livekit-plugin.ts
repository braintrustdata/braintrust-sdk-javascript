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
  JobContext,
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
import {
  REDACTED_EXCEPTION_MESSAGE,
  REDACTION_ENABLED,
  isPiiEvent,
  livekitPiiAllowed,
  withoutPii,
} from "./livekit-pii";
import { v4 as uuidv4 } from "uuid";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { Attachment, startSpan, withCurrent, type Span } from "../../logger";
import {
  withSpanInstrumentationName,
  INSTRUMENTATION_NAMES,
} from "../../span-origin";
import { isObject } from "../../../util";
import { zodToJsonSchema } from "../../zod/utils";
import { debugLogger } from "../../debug-logger";
import { isEnvFlagEnabled } from "../../wrappers/attachment-utils";
import {
  DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES,
  type AudioEncodingConfig,
} from "../config";
import { pcmBytesToMs, msToSamples, samplesToMs } from "../../pcm-buffer";
import {
  AudioSessionRecorder,
  type AudioMember,
} from "../../audio-session-recorder";
import { audioSelections, type AudioInterval } from "../../audio-selections";
import {
  audioEncodingStack,
  type AudioEncodingDefaults,
} from "../../audio-compression";
import type { AudioMiddlewareStack } from "../../audio-middleware";

// Bounds on per-session observation state, independent of the attachment threshold.
const MAX_ROWS = 8192;
const MAX_EVENTS = 256;
const MAX_RANGES = 100_000;
const MAX_RECORDING_MS = 30 * 60 * 1000;
const SAMPLE_RATE = 24000;
// The OTel API shares its context key through Symbol.for, including across copies.
const OTEL_SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
const FINAL_TRANSCRIPT = 2; // SpeechEventType.FINAL_TRANSCRIPT
// Voice audio is personal data, so each direction has its own explicit flag rather
// than the shared BRAINTRUST_CAPTURE_ATTACHMENTS, which also enables other media.
const CAPTURE_USER_AUDIO = "BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS";
const CAPTURE_AGENT_AUDIO = "BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS";
/** Speech compresses well as Opus, and Ogg is its standard file format. */
const AUDIO_DEFAULTS: AudioEncodingDefaults = {
  codec: { name: "opus" },
  container: { name: "ogg" },
};

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
    private audio?: AudioEncodingConfig,
  ) {
    super();
  }

  protected onEnable(): void {
    const tracing = (this.tracing = new LiveKitTracing(
      this.streamingAttachmentBufferBytes,
      () => audioEncodingStack(this.audio, AUDIO_DEFAULTS),
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
      livekitChannels.jobContext.intercept((target, self, args) => {
        // Read the job context as LiveKit's own redaction does, without requiring one.
        tracing.jobContext ??= () =>
          Reflect.apply(target, self, [false]) as JobContext | undefined;
        return Reflect.apply(target, self, args);
      }),
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
  /** Confirmed playout on the session timeline, for this speech's selections. */
  played?: AudioInterval[];
  messages?: Map<string, string | undefined>;
};
type SessionState = {
  root: Row;
  /** Exported rows. Folded rows resolve through their owner. */
  rows: Map<string, Row>;
  rowLimitWarned: boolean;
  relationships: Relationships;
  speech: SpeechTracker;
  /** STT spans per user turn, for context links to the turn's message. */
  transcripts: Map<string, { span: Span; end: number }[]>;
  /** The session clock's epoch, shared with the audio session's timeline. */
  origin: number;
  /**
   * Whether LiveKit times user speech with a local VAD on the input audio. The
   * STT provider's speech events otherwise time it, as received over the network.
   */
  localVad?: boolean;
  /** Describes the session's audio, and records it when capture is enabled. */
  audio: AudioSessionRecorder;
  /** Captures audio into `audio`; only when attachment capture is enabled. */
  recording?: Recording;
  playback?: Playback;
  /**
   * Whether LiveKit marked one of the session's spans for redaction. It marks
   * every span of a redacted job, so this also covers observations that have no
   * native span of their own, such as transcripts and playback.
   */
  redacted?: boolean;
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
    inference: { model?: Row; tts?: Row };
    /** Tool configuration of the enclosing pipeline reply, for its llm spans. */
    request?: Record<string, unknown>;
  }>();
  readonly sessions = new Map<string, SessionState>();
  /** LiveKit's current job context, which carries its project redaction setting. */
  jobContext?: () => JobContext | undefined;
  // Callbacks already handed to LiveKit can outlive interceptor unsubscription.
  private disabled = false;

  constructor(
    private streamingAttachmentBufferBytes: number,
    private audioMiddleware?: () => AudioMiddlewareStack,
  ) {}

  private rowOf(span: LiveKitSpan | undefined): Row | undefined {
    const row = span && observedRows.get(span);
    return row &&
      this.sessions.get(row.session)?.rows.has((row.owner ?? row).id)
      ? row
      : undefined;
  }
  /**
   * The session's audio recorder. Audio is recorded only when capture is
   * enabled; each segment uploads as an attachment on the session span.
   */
  private audioSession(
    span: Span,
    origin: number,
    capturing: boolean,
  ): AudioSessionRecorder {
    // Each recording builds its own stack, so plugin state is never shared.
    let middleware: AudioMiddlewareStack = [];
    let failed = false;
    if (capturing)
      try {
        middleware = this.audioMiddleware?.() ?? [];
      } catch (error) {
        failed = true;
        debugLogger.notice.warn(
          "LiveKit audio middleware failed to start.",
          error,
        );
      }
    const audio = new AudioSessionRecorder({
      origin,
      sources: SOURCES,
      ...(capturing && {
        audio: {
          sampleRate: SAMPLE_RATE,
          segmentBytes: this.streamingAttachmentBufferBytes,
          maxDurationMs: MAX_RECORDING_MS,
          middleware,
        },
      }),
      onFile: async ({ id, data, mimeType, metadata }) => {
        if (!data || !mimeType) return span.log({ metadata });
        const attachment = new Attachment({
          data,
          filename: `${id}.${fileExtension(mimeType)}`,
          contentType: mimeType,
        });
        const status = await attachment.upload();
        if (status.upload_status !== "done")
          throw new Error(status.error_message ?? "attachment_upload_failed");
        // The file and the entry that describes it land in one write.
        span.log({
          input: { audio: { [id]: attachment.reference } },
          metadata,
        });
      },
    });
    if (failed) audio.stop("recording_transform_failed");
    return audio;
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
    // LiveKit's span processors stamp its session metadata when a span starts.
    // Honor its redaction flag before starting publishes any of the span's content.
    const stamped = span.attributes?.[REDACTION_ENABLED] === true;
    const row = this.start(
      stamped
        ? {
            ...options,
            attributes: { ...options.attributes, [REDACTION_ENABLED]: true },
          }
        : options,
      this.rowOf(parent),
    );
    if (!row) return;
    observedRows.set(span, row);
    this.observeRedaction(row);
    // Only model requests inside an llm_node contribute to their exported owner.
    // Leave other folded spans untouched, including their native recording state.
    if (
      row.owner &&
      (row.name !== "llm_request" || row.owner.name !== "llm_node")
    )
      return;
    const finish = () => this.end(row);
    const piiAllowed = () => this.piiAllowed(row);
    const observeRedaction = () => this.observeRedaction(row);
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
        if (!row.ended)
          row.span.log({
            error: piiAllowed() ? error : REDACTED_EXCEPTION_MESSAGE,
          });
      },
      setAttribute(this: LiveKitSpan, key: string, value: unknown) {
        const result = setAttribute.call(this, key, value);
        if (!row.ended) {
          row.attributes.set(key, value);
          observeRedaction();
        }
        return result;
      },
      setAttributes(this: LiveKitSpan, attributes: Record<string, unknown>) {
        const result = setAttributes.call(this, attributes);
        if (!row.ended) {
          for (const [key, value] of Object.entries(attributes))
            row.attributes.set(key, value);
          observeRedaction();
        }
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
      const captures = {
        input: isEnvFlagEnabled(CAPTURE_USER_AUDIO),
        output: isEnvFlagEnabled(CAPTURE_AGENT_AUDIO),
      };
      const capturing = captures.input || captures.output;
      const origin = Date.now();
      const audio = this.audioSession(row.span, origin, capturing);
      row.span.log({ metadata: audio.session() });
      const transcripts: SessionState["transcripts"] = new Map();
      this.sessions.set(id, {
        root: row,
        rows,
        rowLimitWarned: false,
        relationships,
        speech: new SpeechTracker(relationships, (turn) =>
          (transcripts.get(turn) ?? []).map((t) => t.span),
        ),
        transcripts,
        origin,
        audio,
        recording: capturing
          ? new Recording(audio, origin, captures)
          : undefined,
        closed: false,
      });
    }
    if (owner) return row;
    const state = this.sessions.get(row.session)!;
    state.rows.set(id, row);
    if (name === "agent_speaking") {
      row.span.log({ metadata: { "audio.source_id": "agent-output" } });
      state.playback?.speechStarted(id);
    }
    const scope = this.context.getStore();
    if (name === "llm_node" && scope) {
      scope.inference.model = row;
      if (scope.request)
        row.span.log({
          metadata: this.piiAllowed(row)
            ? scope.request
            : // LiveKit treats tool definitions as PII; the choice is configuration.
              { tool_choice: scope.request.tool_choice },
        });
    }
    if (name === "tts_node" && scope) scope.inference.tts = row;
    // Played audio comes from the reply's synthesis when it has one, otherwise
    // directly from its model response; synthesis comes from the model response.
    const generator =
      name === "agent_speaking"
        ? (scope?.inference.tts ?? scope?.inference.model)
        : name === "tts_node"
          ? scope?.inference.model
          : undefined;
    if (generator)
      state.relationships.link(row.span, generator.span, "generated_by");
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
    // Native identities resolve links in memory; only redacted values are logged.
    const identities = nativeFields(row.attributes);
    const native = this.redact(row);
    const attrs = nativeFields(native);
    const events = this.redactEvents(row);
    if (row.status.message && !this.piiAllowed(row))
      row.status = { ...row.status, message: REDACTED_EXCEPTION_MESSAGE };
    row.attributes = new Map();
    row.events = [];
    const state = this.sessions.get(row.session);
    if (!row.owner) {
      row.span.log(endEvent(row, attrs, events));
      if (state) correlate(row, identities, state.relationships);
      if (state && row.name === "user_speaking")
        row.span.log({
          metadata: {
            "audio.source_id": "session-input",
            ...participantIds(state, native),
            ...(state.localVad && row.end !== undefined
              ? userSelections(state, row.start * 1000, row.end * 1000)
              : {}),
          },
        });
      if (state && row.name === "agent_speaking")
        row.span.log({ metadata: participantIds(state, native) });
      row.span.end({ endTime: row.end });
    } else {
      // Native request spans duplicate the public inference lifecycle.
      row.span.log(modelFields(attrs));
    }
    if (row.name === "agent_session") void this.closeSession(row.id);
    if (state?.closed) this.clearSession(row.session);
  }

  /**
   * Whether LiveKit's configuration allows PII in a row's telemetry: neither
   * the environment, the job, nor LiveKit's redaction flag on the row's span or
   * session disallows it.
   */
  private piiAllowed(row: Row): boolean {
    return (
      row.attributes.get(REDACTION_ENABLED) !== true &&
      !this.sessions.get(row.session)?.redacted &&
      livekitPiiAllowed(this.jobContext?.())
    );
  }

  /** Remembers LiveKit's redaction flag for the session, once a span carries it. */
  private observeRedaction(row: Row): void {
    const state = this.sessions.get(row.session);
    if (state && row.attributes.get(REDACTION_ENABLED) === true)
      state.redacted = true;
  }

  /** Native attributes as LiveKit would export them: without PII when it's not allowed. */
  private redact(row: Row): Map<string, unknown> {
    return this.piiAllowed(row) ? row.attributes : withoutPii(row.attributes);
  }

  private redactEvents(row: Row): Row["events"] {
    const { events } = row;
    if (this.piiAllowed(row)) return events;
    return events
      .filter((event) => !isPiiEvent(event.name))
      .map((event) => ({
        ...event,
        ...(event.attributes && {
          attributes: Object.fromEntries(
            withoutPii(Object.entries(event.attributes)),
          ),
        }),
      }));
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
      ? {
          model: found.name === "llm_node" ? found : undefined,
          tts: found.name === "tts_node" ? found : undefined,
        }
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
      ...(this.piiAllowed(parent)
        ? { output: [{ role: "user", content: alternative.text }] }
        : {}),
      metadata: {
        "audio.source_id": "session-input",
        // The room participant LiveKit linked to this turn's input, if any.
        ...(parent === turn ? participantIds(state, turn.attributes) : {}),
        ...speakerIds(state, recognition, alternative.speakerId || undefined),
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
  }

  conversation(session: AgentSession, item: ChatMessage): void {
    const state = this.sessionOf(session);
    if (item?.type !== "message" || !state) return;
    const current = this.context.getStore()?.row;
    const scoped =
      current?.session === state.root.id
        ? state.rows.get(current.turn ?? "")
        : undefined;
    if (item.role === "user") {
      // LiveKit commits a user turn with that turn's native start, or in its scope.
      const turn =
        state.speech.turnOf(item) ??
        (scoped?.name === "user_turn" ? scoped.id : undefined);
      state.speech.user(item, turn);
      if (turn)
        state.rows.get(turn)?.span.log({ metadata: messageMetadata(item) });
      return;
    }
    if (item.role !== "assistant") return;
    const turn =
      scoped?.name === "agent_turn"
        ? scoped.id
        : this.rowOf(session.activity?.currentSpeech?._agentTurnSpan)?.id;
    // LiveKit commits a reply before it leaves the speaking state, so the speech
    // that played it is still current. Otherwise, use the turn's only speech.
    const playing = this.rowOf(session.agentSpeakingSpan);
    const speeches = [...state.rows.values()].filter(
      (row) => row.name === "agent_speaking" && turn && row.turn === turn,
    );
    const speaking =
      playing && (!turn || playing.turn === turn)
        ? playing
        : speeches.length === 1
          ? speeches[0]
          : undefined;
    // LiveKit falls back to the entire generated text on partial playback when
    // its output has no synchronized transcript. That fallback is not heard text.
    // A pipeline commit can include earlier fully played segments followed by the
    // synchronized partial suffix, so keep a verified prefix too.
    const heard = speaking?.playedText;
    const textContent = item.interrupted
      ? heard && item.textContent?.endsWith(heard)
        ? item.textContent
        : heard
      : item.textContent;
    state.speech.assistant(
      {
        ...item,
        textContent: this.piiAllowed(state.root) ? textContent : undefined,
      },
      speaking,
    );
  }

  input(activity: AgentActivity, stream: ReadableStream<AudioFrame>): void {
    const state = this.sessionOf(activity.agentSession);
    if (!state) return;
    state.localVad =
      activity.vad !== undefined && activity.turnDetectionMode !== "stt";
    if (state.recording?.captures.input) state.recording.attachInput(stream);
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
          state.origin,
          (id) => state.rows.get(id),
          (text) => {
            const row = this.rowOf(session.agentSpeakingSpan);
            if (row) row.playedText = text;
          },
          () => this.piiAllowed(state.root),
          state.recording?.captures.output ? state.recording : undefined,
        )
      : undefined;
  }

  userTurn(activity: AgentActivity, info: EndOfTurnInfo): void {
    const state = this.sessionOf(activity.agentSession);
    const turn = this.rowOf(info.userTurnSpan)?.id;
    const { startedSpeakingAt, stoppedSpeakingAt } = info;
    if (!state || !turn || startedSpeakingAt === undefined) return;
    state.speech.recognize(turn, startedSpeakingAt);
    // First to last speech, including pauses; not the processing that follows.
    if (state.localVad && stoppedSpeakingAt !== undefined)
      state.rows.get(turn)?.span.log({
        metadata: userSelections(state, startedSpeakingAt, stoppedSpeakingAt),
      });
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
      state.closing = (async () => {
        try {
          await state.audio.finish();
          if (state.recording)
            state.root.span.log({ metadata: state.recording.metadata() });
        } finally {
          done();
        }
      })();
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
  if (name === "user_turn" || name === "agent_turn") {
    // A user turn's final transcripts as LiveKit joins them, or the user
    // message (spoken or typed) that prompted an agent turn.
    const text =
      attrs[
        name === "user_turn"
          ? "contrib.livekit.pii.user_transcript"
          : "contrib.livekit.pii.user_input"
      ];
    return typeof text === "string" && text
      ? { input: [{ role: "user", content: text }] }
      : {};
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

/** LiveKit's record of a committed user turn: its message ID and speaking times. */
function messageMetadata(item: ChatMessage) {
  const metrics = item.metrics ?? {};
  return {
    "contrib.livekit.message_id": item.id,
    ...(metrics.startedSpeakingAt !== undefined
      ? { "contrib.livekit.started_speaking_at": metrics.startedSpeakingAt }
      : {}),
    ...(metrics.stoppedSpeakingAt !== undefined
      ? { "contrib.livekit.stopped_speaking_at": metrics.stoppedSpeakingAt }
      : {}),
    ...(metrics.onUserTurnCompletedDelay !== undefined
      ? {
          "contrib.livekit.on_user_turn_completed_delay":
            metrics.onUserTurnCompletedDelay,
        }
      : {}),
  };
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
      relationships.reference(row.span, `speech:${item.id}`, "uses_context");
  }
}

type Relationship =
  | "uses_context"
  | "requested_by"
  | "consumes_tool_result"
  | "generated_by";
type Link = {
  context: { traceId: string; spanId: string; traceFlags: number };
  attributes: { "braintrust.relationship.type": Relationship };
};

/**
 * Session-local identity resolution. A native identity can name several spans,
 * such as a user message's transcripts, and a late target still resolves an
 * earlier reference.
 */
class Relationships {
  private warned = false;
  private targets = new Map<string, Span[]>();
  private waiting = new Map<string, Map<Span, Relationship>>();
  private links = new Map<Span, Map<string, Link>>();

  register(id: string, target: Span): void {
    const targets = this.targets.get(id) ?? [];
    if (targets.includes(target) || targets.length >= MAX_EVENTS) return;
    targets.push(target);
    this.targets.set(id, targets);
    for (const [source, relationship] of this.waiting.get(id) ?? [])
      this.link(source, target, relationship);
  }

  reference(source: Span, id: string, relationship: Relationship): void {
    for (const target of this.targets.get(id) ?? [])
      this.link(source, target, relationship);
    // Later targets for this identity still link to this source.
    if (this.waiting.size < MAX_ROWS || this.waiting.has(id)) {
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

/**
 * Associates committed messages with the spans they describe, using only native
 * identities and structure, never timing. A user message is the transcript of
 * its user turn, so it resolves to that turn's STT spans. An assistant message
 * is committed while LiveKit still holds the speech that played it.
 */
class SpeechTracker {
  /** User turns by LiveKit's native turn start, which its messages carry. */
  private turns = new Map<number, string | undefined>();
  private owners = new Map<string, Row>();
  private pending = new Map<string, ChatMessage>();

  constructor(
    private relationships: Relationships,
    /** A user turn's STT spans, in arrival order. */
    private transcripts: (turn: string) => Span[],
  ) {}

  /** Keys a user turn by the native start time LiveKit also stamps on its message. */
  recognize(turn: string, startedAt: number): void {
    if (!Number.isFinite(startedAt)) return;
    const start = startedAt / 1000;
    // Two turns with one native key are ambiguous; neither resolves.
    this.turns.set(
      start,
      !this.turns.has(start) || this.turns.get(start) === turn
        ? turn
        : undefined,
    );
  }

  /** The user turn a committed user message transcribes, if LiveKit identifies one. */
  turnOf(item: ChatMessage): string | undefined {
    const start = item.metrics?.startedSpeakingAt;
    return start === undefined ? undefined : this.turns.get(start);
  }

  /** Makes a user message's transcripts the target of model context links. */
  user(item: ChatMessage, turn: string | undefined): void {
    if (!turn) return;
    for (const span of this.transcripts(turn))
      this.relationships.register(`speech:${item.id}`, span);
  }

  /** Records an assistant message as the played text of the speech that produced it. */
  assistant(item: ChatMessage, row: Row | undefined): void {
    // Keep only transcript observations, never ChatMessage audio/context payloads.
    item = {
      type: item.type,
      id: item.id,
      role: item.role,
      textContent: item.textContent,
      interrupted: item.interrupted,
    };
    row = this.owners.get(item.id) ?? row;
    if (!row) {
      if (this.pending.size < MAX_ROWS) this.pending.set(item.id, item);
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
            output: [...messages.values()]
              .filter((content) => content !== undefined)
              .map((content) => ({ role: "assistant", content })),
          }
        : {}),
      metadata: {
        "contrib.livekit.message_ids": [...messages.keys()],
        ...(item.interrupted ? { "contrib.livekit.interrupted": true } : {}),
      },
    });
  }

  /** Keeps assistant text that LiveKit committed without played speech. */
  finish(root: Span): void {
    if (this.pending.size)
      root.log({
        metadata: {
          "contrib.livekit.unassociated_messages": [
            ...this.pending.values(),
          ].map((item) => ({
            id: item.id,
            role: item.role,
            text: item.textContent,
          })),
        },
      });
  }
}

/** LiveKit's native audio boundaries, published as the session's source IDs. */
type Source = "session-input" | "agent-output";
const SOURCES: Record<Source, { label: string }> = {
  "session-input": { label: "Agent input audio" },
  "agent-output": { label: "Agent audio" },
};
type Packet = {
  pcm: Int16Array;
  rate: number;
  channels: number;
  source: Source;
  /** Session-clock offset in milliseconds; relative to its run while staged. */
  at: number;
};

const inputs = new WeakMap<object, Recording>();
const sinks = new WeakMap<object, Playback>();
/**
 * Each recognizer labels its speakers independently: the same label from two
 * recognizers need not be the same voice. Opaque per-recognizer scope keys.
 */
const labelingScopes = new WeakMap<object, number>();
const labelingScope = (recognition: object) => {
  let scope = labelingScopes.get(recognition);
  if (scope === undefined)
    labelingScopes.set(recognition, (scope = nextLabelingScope++));
  return scope;
};
let nextLabelingScope = 1;

/**
 * Captures a session's LiveKit audio into its AudioSessionRecorder: validates
 * frames, keeps the input and playout clocks, and decides when it is safe to cut.
 */
class Recording {
  /** Session-clock playout that each pending output run may still add audio before. */
  readonly holds = new Map<object, number>();
  private formats: Record<
    Source,
    Map<string, { sample_rate_hz: number; channel_count: number }>
  > = { "session-input": new Map(), "agent-output": new Map() };
  private inputStream?: object;
  private inputEnd?: number;

  constructor(
    private audio: AudioSessionRecorder,
    /** The session clock's epoch, shared with the audio session's timeline. */
    readonly origin: number,
    /** Which directions this recording captures: caller input, agent output. */
    readonly captures = { input: true, output: true },
  ) {}

  get active(): boolean {
    return this.audio.active;
  }
  get closed(): boolean {
    return this.audio.closed;
  }
  get reason(): string | undefined {
    return this.audio.reason;
  }
  stop(reason: string): void {
    this.audio.stop(reason);
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
    if (
      !this.audio.record(packet.source, packet.pcm, {
        sampleRate: packet.rate,
        channelCount: packet.channels,
        offsetMs: packet.at,
      })
    )
      return false;
    this.formats[packet.source].set(`${packet.rate}:${packet.channels}`, {
      sample_rate_hz: packet.rate,
      channel_count: packet.channels,
    });
    return true;
  }

  /** Copies an output frame until playout confirms or discards it. */
  stage(frame: AudioFrame): Int16Array | undefined {
    const data = this.samples(frame);
    if (!data || !this.audio.reserve(data.byteLength)) return;
    // LiveKit may reuse the frame while captureFrame is awaiting the sink.
    return data.slice();
  }
  unstage(pcm: Int16Array): void {
    this.audio.release(pcm.byteLength);
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
        source: "session-input",
        at,
      })
    )
      return;
    this.inputEnd = at + duration;
    this.advance();
  }

  /**
   * Records the staged frames that confirmed playout covers, then releases
   * frames that can no longer play. Only confirmed output advances a run's
   * hold; generated or queued audio never does.
   */
  confirm(
    run: Run,
    ranges: PlaybackProgressedEvent[],
    unmapped: boolean,
  ): void {
    if (!this.active) return this.drop(run);
    if (unmapped && run.duration) {
      this.stop("output_playout_mapping_unavailable");
      return this.drop(run);
    }
    for (const range of ranges) {
      if (
        ![range.startedAt, range.offset, range.duration].every(
          Number.isFinite,
        ) ||
        range.offset < run.processed - samplesToMs(1) ||
        range.duration < 0
      ) {
        this.stop("invalid_playout_range");
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
          range.startedAt - this.origin + from - range.offset,
        );
        this.record({ ...frame, pcm, at });
      }
      run.processed = end;
      this.holds.set(
        run,
        Math.max(0, range.startedAt - this.origin + range.duration),
      );
    }
    run.frames = run.frames.filter((frame) => {
      const consumed =
        run.finished ||
        !this.active ||
        frame.at +
          pcmBytesToMs(frame.pcm.byteLength, frame.rate, frame.channels) <=
          run.processed + samplesToMs(1);
      if (consumed) this.unstage(frame.pcm);
      return !consumed;
    });
    if (run.finished) this.holds.delete(run);
    this.advance();
  }

  /** Releases a run's staged frames and its hold. */
  drop(run: Run): void {
    for (const frame of run.frames.splice(0)) this.unstage(frame.pcm);
    this.holds.delete(run);
  }

  /** Only cut where neither input nor a queued playback run can still add audio. */
  advance(): void {
    const wall = Date.now() - this.origin - 1000;
    this.audio.advance(
      Math.min(
        wall,
        this.inputStream ? (this.inputEnd ?? 0) : wall,
        ...this.holds.values(),
      ),
    );
  }

  /** LiveKit's native capture details for the session span. */
  metadata(): Record<string, unknown> {
    return {
      "contrib.livekit.audio.input_formats": [
        ...this.formats["session-input"].values(),
      ],
      "contrib.livekit.audio.output_formats": [
        ...this.formats["agent-output"].values(),
      ],
      // The schema has no recording-level outcome; keep LiveKit's reason natively.
      ...(this.reason
        ? { "contrib.livekit.audio.stop_reason": this.reason }
        : {}),
    };
  }
}

/** The schema's role for LiveKit's native participant kinds. */
const PARTICIPANT_TYPES: Record<string, AudioMember["type"]> = {
  STANDARD: "user",
  SIP: "user",
  // Bridges an outside user, e.g. from a messaging platform, into the room.
  CONNECTOR: "user",
  AGENT: "agent",
  INGRESS: "other",
  EGRESS: "other",
};

/**
 * The room connection LiveKit stamped on a span: the caller whose audio it
 * heard, or the agent's own connection. Published on first sight; a session
 * without a room has no participants.
 */
function participantIds(
  state: SessionState,
  native: Map<string, unknown>,
): { "audio.participant_ids"?: string[] } {
  const sid = native.get("lk.participant_id");
  if (typeof sid !== "string" || !sid) return {};
  const kind = native.get("lk.participant_kind");
  const { id, added } = state.audio.participant(sid, {
    type: (typeof kind === "string" && PARTICIPANT_TYPES[kind]) || "unknown",
    attributes: {
      "contrib.livekit.participant_id": sid,
      ...(typeof kind === "string"
        ? { "contrib.livekit.participant_kind": kind }
        : {}),
    },
  });
  if (added) state.root.span.log({ metadata: added });
  return { "audio.participant_ids": [id] };
}

/**
 * The voice a diarizing STT identified in the session's input, by its native
 * label within the recognizer that assigned it. Published on first sight; the
 * label is an index, not a name.
 */
function speakerIds(
  state: SessionState,
  recognition: object,
  label: string | undefined,
): Record<string, unknown> {
  if (!label) return {};
  const key = JSON.stringify([labelingScope(recognition), label]);
  const { id, added } = state.audio.speaker("session-input", key, {
    type: "user",
    attributes: { "contrib.livekit.speaker_id": label },
  });
  if (added) state.root.span.log({ metadata: added });
  return { "audio.speaker_ids": [id], "contrib.livekit.speaker_id": label };
}

/** A user interval, in unix milliseconds, as `audio.selections` on the session timeline. */
function userSelections(state: SessionState, from: number, to: number) {
  const selections = audioSelections([
    { start: from - state.origin, end: to - state.origin },
  ]);
  return selections ? { "audio.selections": selections } : {};
}

/** Extends a speech's confirmed playout; contiguous frames grow one interval. */
function played(row: Row, interval: AudioInterval): void {
  const list = (row.played ??= []);
  const last = list.at(-1);
  if (
    last &&
    interval.start >= last.start &&
    interval.start <= last.end + samplesToMs(1)
  )
    last.end = Math.max(last.end, interval.end);
  else if (list.length < MAX_RANGES) list.push(interval);
}

function fileExtension(mimeType: string): string {
  return mimeType.split(";")[0].split("/")[1]?.trim() || "bin";
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
  /** Played intervals seen before the speaking row is known. */
  unclaimed: AudioInterval[];
  started?: number;
  ranges: PlaybackProgressedEvent[];
  finished?: PlaybackFinishedEvent;
  inFlight: number;
  processed: number;
  hadProgress: boolean;
};

/**
 * One session's audio sink. Its playback events always place played speech on
 * the timeline and report heard text; when recording, confirmed frames are
 * also recorded.
 */
class Playback {
  private runs: Run[] = [];
  private current?: Run;
  private listeners: [string, (event: any) => void][];
  private recording?: Recording;
  private playbackEvents = new Map<string, unknown[]>();

  constructor(
    readonly sink: AudioOutput,
    private session: AgentSession,
    /** The session clock's epoch, shared with the audio session's timeline. */
    private origin: number,
    private resolve: (id: string) => Row | undefined,
    private heard: (text: string | undefined) => void,
    /** Whether heard text may be kept in native playback events. */
    private piiAllowed: () => boolean,
    recording?: Recording,
  ) {
    this.listeners = [
      [
        "playbackStarted",
        (event) => runInstrumentation(() => this.started(event)),
      ],
      [
        "playbackProgressed",
        (event) => runInstrumentation(() => this.progressed(event)),
      ],
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

  /**
   * LiveKit starts agent speech in response to its first playback, after the
   * sink reports it. Claim that playout for the new speech now, so it keeps its
   * selections even if playback finishes after the speech span ends.
   */
  speechStarted(id: string): void {
    const run = this.runs.find((r) => !r.speaking);
    if (!run) return;
    run.speaking = id;
    this.claim(run);
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
          source: "agent-output",
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
      // A later segment of speech already in progress.
      speaking: observedId(this.session.agentSpeakingSpan),
      unclaimed: [],
      ranges: [],
      inFlight: 0,
      processed: 0,
      hadProgress: false,
    };
    this.runs.push(run);
    this.recording?.holds.set(
      run,
      Math.max(0, Date.now() - this.origin - 1000),
    );
    return run;
  }

  private started(event: { createdAt: number }): void {
    // Captured frames start a run; otherwise playback is the first sign of one.
    // A repeated start while a run is still playing is not a new run.
    const run =
      this.runs.find((r) => r.started === undefined) ??
      (this.runs.length ? undefined : this.startRun());
    if (run) run.started = event.createdAt;
  }

  private progressed(event: PlaybackProgressedEvent): void {
    const run = this.runs[0];
    if (!run) return;
    if (run.ranges.length >= MAX_RANGES) {
      this.recording?.stop("playout_range_limit");
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
    const run = this.runs.find((r) => !r.finished);
    if (!run) return;
    run.finished = event;
    this.settle(run);
  }

  private discard(run: Run): void {
    this.recording?.drop(run);
  }

  /** Confirmed playout: speech selections always; heard frames when recording. */
  private settle(run: Run): void {
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
    run.speaking ??= observedId(this.session.agentSpeakingSpan);
    const ranges = run.ranges.splice(0);
    // Sinks without progress events confirm one contiguous run from its start.
    const contiguous =
      finished &&
      !run.hadProgress &&
      run.started !== undefined &&
      !finished.interrupted;
    if (contiguous)
      ranges.push({
        startedAt: run.started!,
        offset: 0,
        duration: this.recording
          ? Math.min(run.duration, finished.playbackPosition * 1000)
          : finished.playbackPosition * 1000,
      });
    const valid = ranges.filter(
      (range) =>
        [range.startedAt, range.offset, range.duration].every(
          Number.isFinite,
        ) && range.duration >= 0,
    );
    for (const range of valid) {
      const start = range.startedAt - this.origin;
      this.play(run, { start, end: start + range.duration });
    }
    this.recording?.confirm(
      run,
      ranges,
      !!finished && !run.hadProgress && !contiguous,
    );
    if (finished) this.publish(run, finished);
  }

  /** Places played speech on its speech row once that row is known. */
  private play(run: Run, interval: AudioInterval): void {
    if (run.unclaimed.length < MAX_RANGES) run.unclaimed.push(interval);
    this.claim(run);
  }

  private claim(run: Run): void {
    const row = run.speaking && this.resolve(run.speaking);
    if (!row || row.owner || row.name !== "agent_speaking") return;
    for (const interval of run.unclaimed.splice(0)) played(row, interval);
  }

  /** Publishes a finished run's selections and native playback event. */
  private publish(run: Run, finished: PlaybackFinishedEvent): void {
    if (run.owner) {
      const events = this.playbackEvents.get(run.owner) ?? [];
      if (events.length < MAX_EVENTS)
        events.push({
          name: "playbackFinished",
          time_unix_ms: Date.now(),
          attributes: {
            playbackPosition: finished.playbackPosition,
            interrupted: finished.interrupted,
            ...(finished.synchronizedTranscript !== undefined &&
            this.piiAllowed()
              ? { synchronizedTranscript: finished.synchronizedTranscript }
              : {}),
          },
        });
      this.playbackEvents.set(run.owner, events);
    }
    for (const id of [run.owner, run.speaking]) {
      const row = id ? this.resolve(id) : undefined;
      if (!row || row.owner) continue;
      const events = this.playbackEvents.get(id!);
      const selections = row.played && audioSelections(row.played);
      if (events || selections)
        row.span.log({
          metadata: {
            ...(selections ? { "audio.selections": selections } : {}),
            ...(events ? { "contrib.livekit.playback_events": events } : {}),
          },
        });
    }
  }
}

export const _exportsForTestingOnly = {
  LiveKitTracing,
  Recording,
  Playback,
  requestMetadata,
};
