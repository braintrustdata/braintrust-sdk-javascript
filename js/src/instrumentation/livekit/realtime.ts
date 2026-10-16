import { RealtimeMetrics } from "./realtime-metrics";
import { errorMonitor } from "node:events";
import type { Span } from "../../logger";
import { observe, type Capture } from "./runtime";
import { TurnTracker, type Turn } from "./turns";
import { messages, type Message } from "./schema";

type Listener = (event: Record<string, unknown>) => void;
export interface RealtimeSession {
  readonly chatCtx?: { items: unknown[] };
  on(name: string | symbol, callback: Listener): unknown;
  prependListener?(name: string | symbol, callback: Listener): unknown;
  off(name: string | symbol, callback: Listener): unknown;
}

/** Adapts LiveKit's common realtime events, including DuplexRealtimeAdapter. */
export class RealtimeObserver {
  private tracker: TurnTracker;
  private usage: RealtimeMetrics;
  private turns = new Map<string, { span: Span; turn: Turn; ended: boolean }>();
  private messages = new Map<string, Span>();
  private speakingTurn?: Span;
  private dispatchTurn?: string;
  private inputs = new Map<string, ((turn: Turn) => void)[]>();
  private readonly listeners: [string | symbol, Listener][];

  constructor(
    readonly session: RealtimeSession,
    private root: Span,
    private content: boolean,
    private capture: () => Capture | undefined,
    maxPauseMs = 1500,
  ) {
    this.usage = new RealtimeMetrics(session);
    this.tracker = new TurnTracker(
      Number.isFinite(maxPauseMs) && maxPauseMs >= 0 ? maxPauseMs : 1500,
    );
    const listeners: [string | symbol, Listener][] = [
      [
        "input_speech_started",
        () => {
          const previous = this.tracker.pending();
          const observation = this.tracker.start(Date.now());
          if (previous && previous.id !== observation.id)
            this.endTurn(previous);
          const turn = this.publish(observation);
          this.dispatchTurn = observation.id;
          this.speakingTurn = turn;
          // LiveKit creates its speaking span in the same event dispatch. Do not
          // carry parentage into unrelated tasks or local VAD observations.
          queueMicrotask(() => {
            if (this.speakingTurn === turn) this.speakingTurn = undefined;
            if (this.dispatchTurn === observation.id)
              this.dispatchTurn = undefined;
          });
        },
      ],
      [
        "input_speech_stopped",
        () => {
          this.speakingTurn = undefined;
          this.dispatchTurn = undefined;
          const turn = this.tracker.stop(Date.now());
          if (turn) this.publish(turn);
        },
      ],
      [
        "input_audio_transcription_completed",
        (event) => {
          if (typeof event.itemId !== "string") return;
          const turn = this.tracker.transcript(
            {
              id: event.itemId,
              speechId: this.dispatchTurn,
              text:
                this.content && typeof event.transcript === "string"
                  ? event.transcript
                  : undefined,
              start:
                typeof event.turnStartedAt === "number"
                  ? event.turnStartedAt
                  : undefined,
              final: event.isFinal === true,
            },
            Date.now(),
          );
          this.messages.set(event.itemId, this.publish(turn));
        },
      ],
      ["session_reconnected", () => this.endPending()],
      [errorMonitor, () => this.endPending()],
    ];
    this.listeners = listeners.map(([name, listener]) => [
      name,
      (event) => observe(() => listener(event)),
    ]);
    for (const [name, listener] of this.listeners) {
      // Observe before LiveKit's own listener commits the message/starts speech.
      // This does not replace any listener or consume any model streams.
      if (session.prependListener) session.prependListener(name, listener);
      else session.on(name, listener);
    }
  }

  private publish(turn: Turn): Span {
    let span = this.turns.get(turn.id)?.span;
    if (!span) {
      span = this.root.startSpan({
        name: "user_turn",
        type: "task",
        startTime: turn.start / 1000,
      });
      this.turns.set(turn.id, { span, turn, ended: false });
      span.log({
        metadata: {
          "turn.id": span.spanId,
          "contrib.livekit.turn.timing_source": "realtime_session_events",
        },
      });
    }
    span.log({
      ...(turn.text !== undefined
        ? { input: [{ role: "user", content: turn.text }] }
        : {}),
      metadata: {
        ...(turn.messageId
          ? { "contrib.livekit.item_id": turn.messageId }
          : {}),
        ...(turn.incomplete ? { "turn.incomplete": true } : {}),
      },
    });
    for (const update of this.inputs.get(turn.id) ?? []) update(turn);
    if (turn.final || turn.incomplete) this.inputs.delete(turn.id);

    const capture = this.capture();
    if (capture) {
      capture.externalSpans ??= new Map();
      capture.externalSpans.set(span.spanId, span);
    }
    return span;
  }

  private endTurn(turn: Turn): void {
    const entry = this.turns.get(turn.id);
    if (entry && !entry.ended && turn.end !== undefined) {
      entry.span.end({ endTime: turn.end / 1000 });
      entry.ended = true;
    }
  }

  assistantSpeechEnded(at: number): void {
    const turn = this.tracker.boundary(at);
    if (turn) this.endTurn(turn);
  }

  private context(items: unknown[]): Message[] {
    const result: Message[] = [];
    let previousTurn: string | undefined;
    for (const item of items) {
      const turn =
        typeof item === "object" && item !== null && "id" in item
          ? this.tracker.message(String(item.id))
          : undefined;
      for (const message of messages([item]) ?? []) {
        if (
          turn &&
          message.role === "user" &&
          typeof message.content === "string"
        ) {
          const previous = previousTurn === turn.id ? result.at(-1) : undefined;
          if (previous)
            previous.content = String(previous.content) + message.content;
          else result.push(message);
          previousTurn = turn.id;
        } else {
          result.push(message);
          previousTurn = undefined;
        }
      }
    }
    return result;
  }

  captureInput(model: Span): ((messageId: string) => void) | undefined {
    if (!this.content) return;
    const pending = this.tracker.pending();
    const items = [...(this.session.chatCtx?.items ?? [])];
    const excluded = new Set<string>();
    const itemId = (item: unknown) =>
      typeof item === "object" && item !== null && "id" in item
        ? String(item.id)
        : undefined;
    const update = () => {
      const transcripts = new Map(
        pending
          ? this.tracker.transcripts(pending).map(({ id, text }) => [id, text])
          : [],
      );
      // Update fragments where LiveKit placed them. Newly observed caller text
      // follows existing context, even if it belongs to an earlier grouped turn.
      const context = items
        .filter((item) => !excluded.has(itemId(item) ?? ""))
        .map((item) => {
          const id = itemId(item);
          const text = id === undefined ? undefined : transcripts.get(id);
          if (text === undefined) return item;
          transcripts.delete(id!);
          return { id, type: "message", role: "user", content: [text] };
        });
      for (const [id, text] of transcripts)
        context.push({ id, type: "message", role: "user", content: [text] });
      model.log({
        input: this.context(context),
        metadata: { "contrib.livekit.input_scope": "realtime_session_context" },
      });
    };
    update();
    if (pending && !pending.final) {
      const updates = this.inputs.get(pending.id) ?? [];
      updates.push(update);
      this.inputs.set(pending.id, updates);
    }
    // Some adapters commit the generated message before dispatching generation.
    // Its stream identity distinguishes output from the input snapshot.
    return (messageId) => {
      excluded.add(messageId);
      update();
    };
  }

  message(id: string): Span | undefined {
    return this.messages.get(id);
  }

  private endPending() {
    this.speakingTurn = undefined;
    this.dispatchTurn = undefined;
    for (const turn of this.tracker.reset(Date.now())) this.publish(turn);
    for (const { turn } of this.turns.values()) this.endTurn(turn);
    this.inputs.clear();
  }

  captureMetrics(responseId: string, span: Span) {
    this.usage.associate(responseId, span);
  }

  close() {
    this.usage.close();
    for (const [name, listener] of this.listeners)
      this.session.off(name, listener);
    this.endPending();
    this.tracker.close(Date.now());
    this.turns.clear();
    this.messages.clear();
    this.inputs.clear();
  }

  takeSpeakingTurn(): Span | undefined {
    const turn = this.speakingTurn;
    this.speakingTurn = undefined;
    return turn;
  }
}
