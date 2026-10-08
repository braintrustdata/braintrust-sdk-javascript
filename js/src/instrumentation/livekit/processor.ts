import type { AudioExtension, Recording, RecordingOptions } from "./audio";
import type { LiveKitOptions } from "./options";
import { resolveAudioOptions } from "./node/audio-options";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
import type {
  AgentSession,
  AgentActivity,
  EndOfTurnInfo,
  ChatMessage,
  AudioFrame,
} from "./types";
import iso from "../../isomorph";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import {
  parse,
  operation,
  isContentKey,
  messages,
  modelFields,
} from "./schema";
import { RealtimeObserver } from "./realtime";
import {
  Attachment,
  currentSpan,
  withCurrent,
  type Logger,
} from "../../logger";
import {
  installRuntime,
  nativeId,
  nativeFields,
  observe,
  seconds,
  type NativeSpan,
  type Capture,
  type Row,
} from "./runtime";
import { instrumentInput, instrumentOutput, release, select } from "./capture";
import {
  withSpanInstrumentationName,
  INSTRUMENTATION_NAMES,
} from "../../span-origin";

export { wrapLiveKitSession } from "./wrap";

/**
 * Export native LiveKit traces through the SDK, with optional bounded audio recording.
 * Install in LiveKit's tracer provider INSTEAD OF another Braintrust span processor.
 * Media capture requires the normal braintrust/hook.mjs loader (LiveKit 1.9.x).
 */
export class LiveKitSpanProcessor {
  private execution = iso.newAsyncLocalStorage<boolean>();
  readonly rows = new Map<string, Row>();
  readonly captures = new WeakMap<object, Capture>();
  private active = new Set<Capture>();
  private exporters = new WeakMap<Capture, Recording>();
  private speakingByTurn = new Map<string, Set<Row>>();
  private realtimeObservers = new Map<AgentSession, RealtimeObserver>();
  private jobs = new Set<Promise<void>>();
  private uninstall: () => void;
  private captureContent: boolean;
  private audio?: AudioExtension;
  private user: boolean;
  private agent: boolean;
  private requests = new Map<string, string>();
  private consumed = new Set<string>();
  constructor(
    private options: LiveKitOptions & {
      logger: Logger<any>;
      recording?: RecordingOptions & { encoder?: { module: string } };
    },
  ) {
    this.captureContent = options.captureContent ?? false;
    const audio = resolveAudioOptions(options);
    this.user = audio.user;
    this.agent = audio.agent;
    this.audio = audio.extension;
    this.uninstall = installRuntime(this);
  }
  /** @internal Applies the native content policy to automatic instrumentation. */
  setContentCapture(enabled: boolean): void {
    this.captureContent = enabled;
  }
  onStart(native: any): void {
    const id = nativeId(native);
    if (!id || this.rows.has(id) || this.rows.size >= 8192) return;
    const parent = native.parentSpanContext?.spanId ?? native.parentSpanId;
    const parentRow = this.rows.get(parent);
    if (native.name !== "agent_session" && !parentRow) return;
    // Native request/run spans duplicate the public inference lifecycle. Keep their
    // measured usage on that operation without exporting another generation row.
    if (
      parentRow &&
      ["llm_request", "llm_request_run", "tts_request_run"].includes(
        native.name,
      )
    ) {
      const context = native.spanContext();
      this.rows.set(id, {
        ...parentRow,
        native: { name: native.name, spanContext: () => context },
        parent,
        folded: true,
        ended: false,
      });
      return;
    }
    const speakingTurn =
      native.name === "user_speaking" &&
      parentRow?.native.name === "agent_session"
        ? [...this.realtimeObservers]
            .find(([session]) => nativeId(session.sessionSpan) === parent)?.[1]
            .takeSpeakingTurn()
        : undefined;
    const span = (
      speakingTurn ??
      parentRow?.span ??
      this.options.logger
    ).startSpan(
      withSpanInstrumentationName(
        {
          name: operation(native.name),
          type: ["llm_node", "realtime_inference"].includes(native.name)
            ? ("llm" as const)
            : native.name === "function_tool"
              ? ("tool" as const)
              : ("task" as const),
          startTime: seconds(native.startTime),
        },
        INSTRUMENTATION_NAMES.LIVEKIT,
      ),
    );
    // Keep only identity after export; retaining the native SDK span would also
    // retain every historical chat context until session/recording finalization.
    const nativeContext = native.spanContext();
    const row: Row = {
      span,
      native: { name: native.name, spanContext: () => nativeContext },
      parent,
      replyTo: parentRow?.replyTo,
      session: native.name === "agent_session" ? id : parentRow?.session,
      turn: ["agent_turn", "user_turn"].includes(native.name)
        ? id
        : (speakingTurn?.spanId ?? parentRow?.turn),
    };
    this.rows.set(id, row);
    if (["agent_speaking", "user_speaking"].includes(native.name) && row.turn) {
      const speaking = this.speakingByTurn.get(row.turn) ?? new Set<Row>();
      speaking.add(row);
      this.speakingByTurn.set(row.turn, speaking);
    }
    if (native.name === "agent_session" && (this.user || this.agent))
      span.log({
        metadata: {
          "audio.recordings": [
            {
              id: "call",
              state: "pending",
            },
          ],
        },
      });
    if (native.name === "function_tool") {
      const request = [...this.rows.values()].find(
        (r) =>
          r.span.spanId === currentSpan().spanId &&
          ["realtime_inference", "llm_node"].includes(r.native.name) &&
          r.session === row.session,
      );
      if (request)
        span.log({
          metadata: { "contrib.livekit.request_span_id": request.span.spanId },
        });
    }
    if (native.name === "agent_turn") {
      const input = [...this.rows.values()].find(
        (r) =>
          r.span.spanId === currentSpan().spanId &&
          r.native.name === "user_turn" &&
          r.session === row.session,
      );
      if (input) {
        row.replyTo = input.span.spanId;
        span.log({
          metadata: { "turn.reply_to": input.span.spanId },
        });
      }
    }
    if (row.turn)
      span.log({
        metadata: {
          "turn.id":
            speakingTurn?.spanId ?? this.rows.get(row.turn)?.span.spanId,
          ...(speakingTurn
            ? {
                "contrib.livekit.turn.association":
                  "provider_speech_start_dispatch",
              }
            : {}),
        },
      });
  }
  onEnd(native: NativeSpan): void {
    const row = this.rows.get(nativeId(native)!);
    if (!row) return;
    if (row.folded) {
      if (native.name === "llm_request") {
        const fields = modelFields(nativeFields(native.attributes));
        row.span.log(fields);
      }
      row.ended = true;
      return;
    }
    const attrs = nativeFields(native.attributes);
    for (const key of Object.keys(attrs))
      if (!this.captureContent && isContentKey(key)) delete attrs[key];
    const events = (native.events ?? []).slice(0, 256).map((e) => ({
      name: e.name,
      time_unix_ms: seconds(e.time) * 1000,
      attributes: Object.fromEntries(
        Object.entries(nativeFields(e.attributes)).filter(
          ([key]) => this.captureContent || !isContentKey(key),
        ),
      ),
    }));
    const toolName =
      attrs["contrib.livekit.function_tool.name"] ?? attrs["gen_ai.tool.name"];
    row.span.log({
      metadata: {
        ...Object.fromEntries(
          Object.entries(attrs).filter(
            ([key]) =>
              !isContentKey(key) &&
              key !== "contrib.livekit.realtime_model_metrics" &&
              !key.startsWith("langfuse."),
          ),
        ),
        ...(events.length ? { "contrib.livekit.events": events } : {}),
      },
      ...(toolName
        ? { span_attributes: { name: toolName, type: "tool" } }
        : {}),
      ...(native.status?.code === 2
        ? {
            error: this.captureContent
              ? (native.status.message ?? "LiveKit operation failed")
              : "LiveKit operation failed",
          }
        : {}),
    });
    if (
      native.name === "user_turn" &&
      !attrs["contrib.livekit.pii.user_transcript"] &&
      [...this.realtimeObservers.keys()].some(
        (session) => nativeId(session.sessionSpan) === row.session,
      )
    ) {
      row.span.log({ span_attributes: { name: "livekit.input_observation" } });
    }
    const fields = modelFields(attrs);
    row.span.log({
      metadata: fields.metadata,
      ...(["llm_node", "realtime_inference"].includes(native.name)
        ? { metrics: fields.metrics }
        : {}),
    });
    if (this.captureContent) {
      if (["llm_node", "realtime_inference"].includes(native.name)) {
        const input =
          messages(attrs["contrib.livekit.pii.chat_ctx"]) ??
          messages(attrs["gen_ai.input.messages"]);
        let output = messages(attrs["gen_ai.output.messages"]);
        if (!output?.length) {
          const text = attrs["contrib.livekit.pii.response.text"];
          const calls =
            parse(attrs["contrib.livekit.pii.response.function_calls"]) ??
            messages(attrs["gen_ai.output.messages"])?.flatMap(
              (message) => message.tool_calls ?? [],
            );
          output = messages([
            ...(typeof text === "string"
              ? [{ role: "assistant", content: text }]
              : []),
            ...(Array.isArray(calls)
              ? calls.map((call) => ({
                  ...call,
                  type: "function_call",
                  call_id: call.call_id ?? call.callId ?? call.id,
                }))
              : []),
          ]);
        }
        row.span.log({
          ...(input ? { input } : {}),
          ...(output?.length ? { output } : {}),
        });
        const turn = this.rows.get(row.turn ?? "");
        if (turn)
          for (const message of output ?? [])
            if (message.tool_calls?.length) {
              turn.messages ??= new Map();
              turn.messages.set(
                message.tool_calls.map((call) => call.id).join(":"),
                message,
              );
              turn.span.log({ output: [...turn.messages.values()] });
            }
      } else if (native.name === "user_turn") {
        const transcript = attrs["contrib.livekit.pii.user_transcript"];
        if (typeof transcript === "string")
          row.span.log({ input: [{ role: "user", content: transcript }] });
      } else if (native.name === "tts_node") {
        const text = attrs["contrib.livekit.pii.input_text"];
        if (typeof text === "string")
          row.span.log({
            input: { text },
            output: [{ role: "assistant", content: text }],
          });
      }
      if (toolName)
        row.span.log({
          input: parse(
            attrs["contrib.livekit.pii.function_tool.arguments"] ??
              attrs["gen_ai.tool.call.arguments"],
          ),
          output: parse(
            attrs["contrib.livekit.pii.function_tool.output"] ??
              attrs["gen_ai.tool.call.result"],
          ),
        });
      this.correlate(row, attrs);
    }
    const replyTo = row.replyTo ?? this.rows.get(row.turn ?? "")?.replyTo;
    if (replyTo) row.span.log({ metadata: { "turn.reply_to": replyTo } });
    row.ended = true;
    row.span.end({ endTime: seconds(native.endTime) });
    if (native.name === "agent_session") {
      const capture = [...this.active].find((c) => c.row === row);
      if (capture) this.track(this.finish(capture.session));
      else {
        if (this.user || this.agent)
          row.span.log({
            metadata: {
              "audio.recordings": [
                {
                  id: "call",
                  state: "omitted",
                  reason: "capture_hooks_not_observed",
                },
              ],
            },
          });
        this.clearSession(nativeId(native)!);
      }
    } else if (
      row.session &&
      this.rows.get(row.session)?.ended &&
      ![...this.active].some((c) => c.row.session === row.session)
    ) {
      this.clearSession(row.session);
    }
  }
  scope<T>(native: any, fn: () => T): T {
    const row = this.rows.get(nativeId(native)!);
    return row
      ? this.execution.run(true, () => withCurrent(row.span, fn))
      : fn();
  }
  inference<T>(fn: () => T): T {
    // Only the inference worker is suppressed, not the pipeline or user tools.
    // An installed processor must not suppress unrelated/untracked sessions.
    return this.execution.getStore()
      ? runWithAutoInstrumentationSuppressed(fn)
      : fn();
  }
  conversation(session: AgentSession, item: ChatMessage): void {
    if (!this.captureContent || item?.type !== "message") return;
    const sessionId = nativeId(session.sessionSpan);
    const current = [...this.rows.values()].find(
      (r) => r.span.spanId === currentSpan().spanId && r.session === sessionId,
    );
    const contextTurn = this.rows.get(current?.turn ?? "");
    const turn =
      item.role === "user"
        ? current?.native.name === "user_turn"
          ? current
          : undefined
        : item.role === "assistant"
          ? contextTurn?.native.name === "agent_turn"
            ? contextTurn
            : this.rows.get(
                nativeId(session.activity?.currentSpeech?._agentTurnSpan) ?? "",
              )
          : undefined;
    const root = this.rows.get(sessionId ?? "");
    // Preserve source identity even when upstream supplies no reliable turn owner.
    const owner = turn ?? root;
    if (!owner) return;
    const metadata = {
      id: item.id,
      role: item.role,
      text: item.textContent,
      interrupted: item.interrupted,
      ...(turn ? { turn_span_id: turn.span.spanId } : {}),
    };
    if (turn && item.role === "assistant") {
      turn.messages ??= new Map();
      turn.messages.set(item.id, {
        role: "assistant",
        content: item.textContent ?? "",
      });
    }
    owner.span.log({
      metadata: {
        "contrib.livekit.committed_messages": { [item.id]: metadata },
      },
      ...(turn
        ? item.role === "user"
          ? { input: [{ role: "user", content: item.textContent ?? "" }] }
          : {
              output: [...(turn.messages?.values() ?? [])],
              metadata: {
                "contrib.livekit.committed_messages": { [item.id]: metadata },
                "contrib.livekit.interrupted": item.interrupted,
              },
            }
        : {}),
    });
  }
  private correlate(row: Row, attrs: Record<string, any>) {
    const calls =
      parse(attrs["contrib.livekit.pii.response.function_calls"]) ??
      messages(attrs["gen_ai.output.messages"])?.flatMap(
        (message) => message.tool_calls ?? [],
      );
    if (Array.isArray(calls))
      for (const call of calls) {
        if (!call || typeof call !== "object") continue;
        const id = call.call_id ?? call.callId ?? call.id;
        if (typeof id === "string")
          this.requests.set(`${row.session}:${id}`, row.span.spanId);
      }
    const callId =
      attrs["gen_ai.tool.call.id"] ?? attrs["contrib.livekit.function_tool.id"];
    const request = this.requests.get(`${row.session}:${callId}`);
    if (request)
      row.span.log({
        metadata: { "contrib.livekit.request_span_id": request },
      });
    const context = parse(attrs["contrib.livekit.pii.chat_ctx"]) as any;
    const fresh = (Array.isArray(context?.items) ? context.items : [])
      .filter(
        (item: any) =>
          item?.type === "function_call_output" &&
          !this.consumed.has(`${row.session}:${item.call_id ?? item.callId}`),
      )
      .map((item: any) => item.call_id ?? item.callId)
      .filter(
        (id: any) =>
          typeof id === "string" && this.requests.has(`${row.session}:${id}`),
      );
    if (fresh.length) {
      for (const id of fresh) this.consumed.add(`${row.session}:${id}`);
      row.span.log({
        metadata: { "continuation.tool_call_ids": fresh },
      });
    }
  }
  begin(session: AgentSession): void {
    if (
      this.captures.has(session) ||
      !this.audio ||
      (!this.user && !this.agent)
    )
      return;
    const row = this.rows.get(nativeId(session.sessionSpan)!);
    if (!row) return;
    const recording = this.audio.createRecording({
      options: this.options.recording,
      audioFormat: this.options.audioFormat,
      encoder: this.options.recording?.encoder,
      span: row.span,
      flush: () => this.options.logger.flush(),
      createAttachment: (options) => new Attachment(options),
      snapshot: () => ({
        origin: capture.origin,
        basis: "local_input_arrival_and_output_playout",
        source: (channel) => ({
          channel_index: channel,
          boundary: channel === 0 ? "session_input" : "local_audio_output",
        }),
        closed: capture.closed,
        metadata: {
          "contrib.livekit.audio.input_formats": [
            ...(capture.recorder.formats.get(0)?.values() ?? []),
          ],
          "contrib.livekit.audio.output_formats": [
            ...(capture.recorder.formats.get(1)?.values() ?? []),
          ],
        },
      }),
      targets: () => this.selectionTargets(capture),
    });
    const capture: Capture = {
      session,
      row,
      user: this.user,
      agent: this.agent,
      origin: Date.now(),
      recorder: recording.recorder,
      timeline: recording.timeline,
      inputTimeline: [],
      inputDurationMs: 0,
      outputHolds: new Map(),
      closed: false,
      selections: new Map(),
      events: new Map(),
      cleanups: [],
    };
    this.exporters.set(capture, recording);
    capture.publishSelections = () => this.publishSelections(capture);
    this.captures.set(session, capture);
    this.active.add(capture);
    row.span.log({
      metadata: { "audio.recordings": [{ id: "call", state: "pending" }] },
    });
  }
  realtime(
    activity: AgentActivity,
    generation?: {
      ev?: { responseId?: string };
      inferenceSpan?: NativeSpan;
      span?: NativeSpan;
    },
  ): void {
    let observer = this.realtimeObservers.get(activity.agentSession);
    const root = this.rows.get(
      nativeId(activity.agentSession.sessionSpan) ?? "",
    );
    if (!observer && root && activity.realtimeSession) {
      observer = new RealtimeObserver(
        activity.realtimeSession,
        root.span,
        this.captureContent,
        () => this.captures.get(activity.agentSession),
      );
      this.realtimeObservers.set(activity.agentSession, observer);
    }
    const model = this.rows.get(nativeId(generation?.inferenceSpan) ?? "");
    if (model) {
      const turn = this.rows.get(nativeId(generation?.span) ?? "");
      const replyTo = observer?.bind(
        generation?.ev?.responseId,
        model.span,
        turn?.span,
      );
      if (replyTo) {
        model.replyTo = replyTo;
        if (turn) turn.replyTo = replyTo;
      }
    }
  }
  input(activity: AgentActivity, stream: ReadableStream<AudioFrame>): void {
    this.realtime(activity);
    const capture = this.captures.get(activity.agentSession);
    if (capture) instrumentInput(capture, stream);
  }
  output(session: AgentSession): void {
    const capture = this.captures.get(session);
    if (capture)
      instrumentOutput(capture, session.output?.audio, this.captureContent);
  }
  userTurn(activity: AgentActivity, info: EndOfTurnInfo): void {
    const c = this.captures.get(activity.agentSession);
    if (!c || c.closed || !c.user) return;
    const id = nativeId(info.userTurnSpan);
    // Native recognition speech boundaries share the local wall clock. Clip actual captured
    // samples; never derive selection from the broader user_turn span's start/end timestamps.
    if (
      !id ||
      !Number.isFinite(info.startedSpeakingAt) ||
      !Number.isFinite(info.stoppedSpeakingAt)
    )
      return;
    for (const p of c.inputTimeline) {
      const from = Math.max(p.at, info.startedSpeakingAt! - c.origin);
      const to = Math.min(
        p.at + p.duration,
        info.stoppedSpeakingAt! - c.origin,
      );
      if (to > from) select(c, id, from, to, 0);
    }
    this.publishSelections(c);
  }
  finish(session: AgentSession): Promise<void> {
    this.realtimeObservers.get(session)?.close();
    this.realtimeObservers.delete(session);
    const c = this.captures.get(session);
    if (!c) return Promise.resolve();
    if (!c.finish) {
      c.finish = this.finalize(c);
      this.track(c.finish);
    }
    return c.finish;
  }
  private track(job: Promise<void>) {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
  }
  private publishManifest(c: Capture) {
    this.exporters.get(c)?.publishManifest();
  }
  private publishSelections(c: Capture) {
    this.exporters.get(c)?.publishSelections();
  }
  private *selectionTargets(c: Capture) {
    for (const [native, intervals] of c.selections) {
      const span = this.rows.get(native)?.span ?? c.externalSpans?.get(native);
      if (!span) continue;
      yield {
        span,
        intervals,
        alias: true,
        metadata: c.events.has(native)
          ? { "contrib.livekit.playback_events": c.events.get(native) }
          : {},
      };
      const speaking = [...(this.speakingByTurn.get(native) ?? [])];
      if (speaking.length === 1) yield { span: speaking[0].span, intervals };
    }
  }
  private async finalize(c: Capture) {
    for (const cleanup of c.cleanups.splice(0)) observe(cleanup);
    c.closed = true;
    const id = nativeId(c.row.native)!;
    try {
      await c.recorder.finish();
      this.publishManifest(c);
      this.publishSelections(c);
      c.row.span.log({
        metadata: {
          "contrib.livekit.audio.input_clock":
            "arrival_anchored_ordered_samples",
        },
      });
    } finally {
      release(c);
      this.captures.delete(c.session);
      c.session = undefined;
      this.active.delete(c);
      this.clearSession(id);
    }
  }
  private clearSession(id: string) {
    // Native children (notably tools) can outlive session end. Retain ownership until
    // every native operation finishes, even after the recording has finalized.
    if ([...this.rows.values()].some((row) => row.session === id && !row.ended))
      return;
    for (const [key, row] of this.rows)
      if (row.session === id) {
        this.rows.delete(key);
        if (row.turn) this.speakingByTurn.delete(row.turn);
      }
    for (const key of this.requests.keys())
      if (key.startsWith(`${id}:`)) this.requests.delete(key);
    for (const key of this.consumed)
      if (key.startsWith(`${id}:`)) this.consumed.delete(key);
  }
  async forceFlush(): Promise<void> {
    await Promise.all([...this.active].map((c) => c.recorder.drain()));
    await Promise.all([...this.jobs]);
    await this.options.logger.flush();
  }
  async shutdown(): Promise<void> {
    await Promise.all([...this.active].map((c) => this.finish(c.session)));
    for (const row of this.rows.values())
      if (!row.ended && !row.folded) {
        row.span.log({
          metadata: {
            ...(row.turn === nativeId(row.native)
              ? { "turn.incomplete": true }
              : { "contrib.livekit.incomplete": true }),
            "contrib.livekit.termination": "processor_shutdown",
          },
        });
        row.span.end();
      }
    for (const observer of this.realtimeObservers.values()) observer.close();
    this.realtimeObservers.clear();
    this.rows.clear();
    this.speakingByTurn.clear();
    this.requests.clear();
    this.consumed.clear();
    try {
      await this.forceFlush();
    } finally {
      this.uninstall();
    }
  }
}
