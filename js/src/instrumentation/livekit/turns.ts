/** A framework-observed caller turn. Times are milliseconds since the Unix epoch. */
export interface Turn {
  id: string;
  start: number;
  end?: number;
  messageId?: string;
  messageIds: string[];
  text?: string;
  final?: boolean;
  incomplete?: boolean;
}

interface Fragment {
  turn: Turn;
  start: number;
  end?: number;
  messageId?: string;
  text?: string;
  final?: boolean;
  transcriptOnly?: boolean;
}

/** Groups speech observations; retains message identity for late transcript updates. */
export class TurnTracker {
  private sequence = 0;
  private active?: Fragment;
  private latest?: Turn;
  private boundaryAfter?: string;
  private unidentified: Fragment[] = [];
  private messages = new Map<string, Fragment>();
  private fragments = new WeakMap<Turn, Fragment[]>();

  constructor(private readonly maxPauseMs = 1500) {}

  private create(at: number): Turn {
    const turn: Turn = {
      id: `turn-${this.sequence++}`,
      start: at,
      messageIds: [],
    };
    this.fragments.set(turn, []);
    return turn;
  }

  start(at: number): Turn {
    if (this.active) return this.active.turn;
    const previous = this.latest;
    const turn =
      previous?.end !== undefined &&
      previous.id !== this.boundaryAfter &&
      at >= previous.end &&
      at - previous.end <= this.maxPauseMs
        ? previous
        : this.create(at);
    delete turn.end;
    turn.final = false;
    const fragment: Fragment = { turn, start: at };
    this.fragments.get(turn)!.push(fragment);
    this.active = fragment;
    this.latest = turn;
    this.unidentified.push(fragment);
    if (this.unidentified.length > 256) this.unidentified.shift();
    return turn;
  }

  stop(at: number): Turn | undefined {
    const fragment = this.active;
    this.active = undefined;
    if (!fragment) return;
    fragment.end = Math.max(fragment.start, at);
    fragment.turn.end = fragment.end;
    return fragment.turn;
  }

  /** Completed playback can separate exchanges even across a short caller pause. */
  boundary(at: number): Turn | undefined {
    if (
      !this.active &&
      this.latest?.end !== undefined &&
      this.latest.end <= at
    ) {
      this.boundaryAfter = this.latest.id;
      return this.latest;
    }
  }

  message(id: string): Turn | undefined {
    return this.messages.get(id)?.turn;
  }

  current(): Turn | undefined {
    return this.active?.turn;
  }

  pending(): Turn | undefined {
    return this.active?.turn ?? this.latest;
  }

  transcript(
    message: {
      id: string;
      text?: string;
      start?: number;
      final: boolean;
      speechId?: string;
    },
    at: number,
  ): Turn {
    let fragment = this.messages.get(message.id);
    if (!fragment) {
      const candidates = this.unidentified.filter(
        (candidate) =>
          message.start === undefined ||
          (message.start >= candidate.start &&
            message.start <= (candidate.end ?? at)),
      );
      fragment =
        this.unidentified.find(
          (candidate) =>
            candidate.turn.id === message.speechId && candidate === this.active,
        ) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!fragment) {
        const turn = this.create(message.start ?? at);
        fragment = { turn, start: turn.start, transcriptOnly: true };
        this.fragments.get(turn)!.push(fragment);
      }
      fragment.messageId = message.id;
      fragment.turn.messageId ??= message.id;
      fragment.turn.messageIds.push(message.id);
      this.unidentified = this.unidentified.filter(
        (candidate) => candidate !== fragment,
      );
      this.messages.set(message.id, fragment);
    }
    if (message.text !== undefined) fragment.text = message.text;
    if (message.final) {
      fragment.final = true;
      if (fragment.transcriptOnly)
        fragment.turn.end = Math.max(fragment.start, at);
    }
    const parts = this.fragments.get(fragment.turn)!;
    fragment.turn.text = parts.some((part) => part.text !== undefined)
      ? parts.map((part) => part.text ?? "").join("")
      : undefined;
    fragment.turn.final = parts.every((part) => part.final);
    return fragment.turn;
  }

  transcripts(turn: Turn): { id: string; text: string }[] {
    return (this.fragments.get(turn) ?? []).flatMap((fragment) =>
      fragment.messageId !== undefined && fragment.text !== undefined
        ? [{ id: fragment.messageId, text: fragment.text }]
        : [],
    );
  }

  /** Finish the current connection without losing historical message identity. */
  reset(at: number): Turn[] {
    const unfinished = new Set([
      ...[...this.messages.values()].map((fragment) => fragment.turn),
      ...(this.active ? [this.active.turn] : []),
    ]);
    const updates = [...unfinished]
      .filter((turn) => turn.end === undefined)
      .map((turn) => {
        turn.end ??= Math.max(turn.start, at);
        turn.incomplete = true;
        return turn;
      });
    this.active = undefined;
    this.latest = undefined;
    this.boundaryAfter = undefined;
    this.unidentified = [];
    return updates;
  }

  close(at: number): Turn[] {
    const updates = this.reset(at);
    this.messages.clear();
    return updates;
  }
}
