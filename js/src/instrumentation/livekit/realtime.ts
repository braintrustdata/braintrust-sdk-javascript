import { errorMonitor } from "node:events";
import type { Span } from "../../logger";
import { isObject } from "../../../util/index";
import { observe, type Capture } from "./runtime";
import { select } from "./capture";
import { messages } from "./schema";

export interface RealtimeSession {
  on(
    name: string | symbol,
    callback: (event: Record<string, unknown>) => void,
  ): unknown;
  off(
    name: string | symbol,
    callback: (event: Record<string, unknown>) => void,
  ): unknown;
}
type User = {
  span: Span;
  start?: number;
  end?: number;
  ended: boolean;
  transcript?: string;
};
/** OpenAI's public plugin events supply item identity lost by generic speech callbacks. */
export class RealtimeObserver {
  private users = new Map<string, User>();
  private replies = new Map<
    string,
    {
      user?: User;
      row?: Span;
      turn?: Span;
      response?: Record<string, unknown>;
      tools?: string[];
      associated?: boolean;
    }
  >();
  private pendingUser?: User;
  private speakingTurn?: Span;
  private toolUsers = new Map<string, User>();
  private pendingTools: string[] = [];
  private continuation: string[] = [];
  private inputValid = true;
  private queuedSamples = 0;
  private connections = 0;
  private readonly receive = (event: Record<string, unknown>) =>
    observe(() => this.server(event));
  private readonly failed = () =>
    observe(() => {
      this.speakingTurn = undefined;
      this.inputValid = false;
      if (this.capture()?.user)
        this.root.log({
          metadata: {
            "contrib.livekit.realtime.input_alignment_invalidated": true,
          },
        });
    });
  private readonly send = (event: Record<string, unknown>) =>
    observe(() => this.client(event));
  constructor(
    private session: RealtimeSession,
    private root: Span,
    private content: boolean,
    private capture: () => Capture | undefined,
  ) {
    session.on("openai_server_event_received", this.receive);
    session.on("openai_client_event_queued", this.send);
    session.on(errorMonitor, this.failed);
  }
  private client(event: Record<string, unknown>) {
    if (
      event.type === "conversation.item.create" &&
      isObject(event.item) &&
      event.item.type === "function_call_output" &&
      typeof event.item.call_id === "string" &&
      this.pendingTools.length < 256
    )
      this.pendingTools.push(event.item.call_id);
    if (event.type === "response.create") {
      this.continuation =
        isObject(event.response) && event.response.input !== undefined
          ? []
          : this.pendingTools.splice(0);
    }
    if (event.type === "input_audio_buffer.clear") this.failed();
    // No audio inspection or sample bookkeeping when recording is off.
    if (
      this.capture()?.user &&
      event.type === "input_audio_buffer.append" &&
      typeof event.audio === "string"
    ) {
      const padding = event.audio.endsWith("==")
        ? 2
        : event.audio.endsWith("=")
          ? 1
          : 0;
      this.queuedSamples += ((event.audio.length / 4) * 3 - padding) / 2;
    }
  }
  private server(event: Record<string, unknown>) {
    if (
      event.type === "input_audio_buffer.speech_started" ||
      event.type === "input_audio_buffer.speech_stopped" ||
      event.type === "session.created"
    )
      this.speakingTurn = undefined;
    if (
      event.type === "session.created" &&
      (this.connections++ > 0 || this.users.size > 0)
    ) {
      this.inputValid = false;
      this.pendingUser = undefined;
      this.pendingTools = [];
      this.continuation = [];
    }
    if (event.type === "error") this.failed();
    const id = typeof event.item_id === "string" ? event.item_id : undefined;
    if (
      event.type === "input_audio_buffer.speech_started" &&
      id &&
      !this.users.has(id)
    ) {
      if (this.users.size >= 256) {
        this.root.log({
          metadata: { "contrib.livekit.realtime.association_limit": true },
        });
        return;
      }
      const span = this.root.startSpan({ name: "user_turn", type: "task" });
      span.log({
        metadata: {
          "turn.id": span.spanId,
          "openai.item_id": id,
          "contrib.livekit.turn.start_event": event.type,
        },
      });
      this.users.set(id, {
        span,
        start:
          typeof event.audio_start_ms === "number"
            ? event.audio_start_ms
            : undefined,
        ended: false,
      });
      // LiveKit 1.9.x synchronously handles this provider event after emitting
      // it, creating user_speaking in the same dispatch. Never carry ownership
      // into later tasks (e.g. local VAD or a delayed/changed provider path).
      this.speakingTurn = span;
      queueMicrotask(() => {
        if (this.speakingTurn === span) this.speakingTurn = undefined;
      });
    } else if (event.type === "input_audio_buffer.speech_stopped" && id) {
      const user = this.users.get(id);
      if (!user) return;
      user.end =
        typeof event.audio_end_ms === "number" ? event.audio_end_ms : undefined;
      user.span.log({
        metadata: {
          "contrib.livekit.turn.stop_event": event.type,
          "openai.input_audio_segments": [
            { item_id: id, audio_start_ms: user.start, audio_end_ms: user.end },
          ],
        },
      });
      user.span.end();
      user.ended = true;
      this.pendingUser = user;
      this.align(user);
    } else if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      id
    ) {
      const user = this.users.get(id);
      if (user && this.content && typeof event.transcript === "string") {
        user.transcript = event.transcript;
        user.span.log({ input: [{ role: "user", content: event.transcript }] });
        for (const reply of this.replies.values()) {
          if (reply.user === user) this.publishInput(reply);
        }
      }
    } else if (
      event.type === "response.output_item.added" &&
      isObject(event.item) &&
      event.item.type === "function_call" &&
      typeof event.item.call_id === "string" &&
      typeof event.response_id === "string"
    ) {
      const user = this.replies.get(event.response_id)?.user;
      if (user && this.toolUsers.size < 256)
        this.toolUsers.set(event.item.call_id, user);
    } else if (
      (event.type === "response.created" || event.type === "response.done") &&
      isObject(event.response) &&
      typeof event.response.id === "string"
    ) {
      const responseId = event.response.id;
      if (this.replies.size >= 256 && !this.replies.has(responseId)) return;
      let response = this.replies.get(responseId) ?? {};
      if (!response.associated) {
        const tools = this.continuation.splice(0);
        const users = new Set(
          tools.map((id) => this.toolUsers.get(id)).filter(Boolean),
        );
        const user =
          this.pendingUser ?? (users.size === 1 ? [...users][0] : undefined);
        response = { ...response, user, tools, associated: true };
        this.pendingUser = undefined;
      }
      if (event.type === "response.done") response.response = event.response;
      this.replies.set(responseId, response);
      this.publish(response);
    }
  }
  private align(user: User) {
    const c = this.capture();
    if (
      !c?.user ||
      !this.inputValid ||
      user.start === undefined ||
      user.end === undefined ||
      c.timeline.msToSamples(user.end) > this.queuedSamples
    )
      return;
    // The supported path forwards mono 24 kHz samples in order. Server speech
    // offsets confirm receipt; resets/reconnects invalidate this sample clock.
    const input = c.inputTimeline;
    if (
      input.some(
        (p) => p.rate !== c.timeline.CALL_SAMPLE_RATE || p.channels !== 1,
      )
    )
      return;
    for (const p of input) {
      const from = Math.max(p.sampleStart, user.start),
        to = Math.min(p.sampleStart + p.duration, user.end);
      if (to > from)
        select(
          c,
          user.span.spanId,
          p.at + from - p.sampleStart,
          p.at + to - p.sampleStart,
          0,
        );
    }
    // Finalization resolves this external turn's selections after audio is ready.
    c.externalSpans ??= new Map();
    c.externalSpans.set(user.span.spanId, user.span);
    c.publishSelections?.();
  }
  bind(responseId: unknown, model: Span, turn?: Span) {
    if (typeof responseId !== "string") return;
    const response = this.replies.get(responseId) ?? {};
    response.row = model;
    response.turn = turn;
    this.replies.set(responseId, response);
    this.publish(response);
    return response.user?.span.spanId;
  }
  private publish(entry: {
    row?: Span;
    turn?: Span;
    response?: Record<string, unknown>;
    user?: User;
    tools?: string[];
  }) {
    if (!entry.row) return;
    this.publishInput(entry);
    if (entry.user) {
      entry.row.log({ metadata: { "turn.reply_to": entry.user.span.spanId } });
      entry.turn?.log({
        metadata: { "turn.reply_to": entry.user.span.spanId },
      });
    }
    if (entry.tools?.length)
      entry.row.log({
        metadata: { "continuation.tool_call_ids": entry.tools },
      });
    if (!entry.response) return;
    entry.row.log({
      metadata: {
        "openai.response.id": entry.response.id,
        "contrib.livekit.response.status": entry.response.status,
      },
    });
    if (this.content) {
      const output = messages(entry.response.output);
      if (output) {
        entry.row.log({ output });
        if (output.some((message) => message.tool_calls?.length))
          entry.turn?.log({ output });
      }
    }
  }
  private publishInput(entry: { row?: Span; user?: User }) {
    if (!this.content || entry.user?.transcript === undefined) return;
    entry.row?.log({
      input: [{ role: "user", content: entry.user.transcript }],
      metadata: { "contrib.livekit.input_scope": "associated_user_turn" },
    });
  }
  close() {
    this.speakingTurn = undefined;
    this.session.off("openai_server_event_received", this.receive);
    this.session.off("openai_client_event_queued", this.send);
    this.session.off(errorMonitor, this.failed);
    for (const user of this.users.values())
      if (!user.ended) {
        user.span.log({ metadata: { "turn.incomplete": true } });
        user.span.end();
      }
    this.users.clear();
    this.toolUsers.clear();
    this.replies.clear();
  }
  takeSpeakingTurn(): Span | undefined {
    const turn = this.speakingTurn;
    this.speakingTurn = undefined;
    return turn;
  }
}
