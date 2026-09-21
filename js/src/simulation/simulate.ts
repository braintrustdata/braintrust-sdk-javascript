/**
 * The run.
 *
 * One simulated user, one agent, one connection, one trace. `simulate()`
 * starts the conversation from the moment it is called and resolves to its
 * thread, so awaiting it later rather than immediately is what leaves room to
 * tell the agent where to go.
 */

import { currentSpan, NOOP_SPAN } from "../logger";
import { Connection } from "./connection";
import { formatThread, summarise, Turn } from "./thread";
import {
  AudioFrame,
  Initiator,
  EndReason,
  Interruption,
  PermissionRecord,
  Role,
  SimulateOptions,
  Summary,
  Thread,
  VoiceRenderer,
} from "./types";

/** What one party says in one turn. */
export interface Utterance {
  text: string;
  audio?: AudioFrame | null;
}

/**
 * Decides what the simulated user says next. Null hangs up.
 *
 * A scripted user returns text and lets the run render it. A speech-native
 * one returns the audio it actually produced, and the text is that audio's
 * own transcript rather than a script the audio was made from.
 */
export type UserBrain = (
  history: ReadonlyArray<Turn>,
) => Promise<Utterance | null>;

export const noAudio: VoiceRenderer = async () => null;

/** The thread's role for a participant named in domain language. */
export const roleOf = (who: Initiator): Role =>
  who === "agent" ? "assistant" : "user";

/** A simulated user, as the run sees it. */
export class SimulatedUser {
  constructor(
    readonly slug: string,
    /** @internal A factory, so a second conversation gets a fresh script. */
    readonly _makeBrain: () => UserBrain,
    /** @internal Who this persona expects to start. */
    readonly _initiator: Initiator = "agent",
  ) {}
}

/**
 * Run one conversation.
 *
 * Returns a promise for the thread. The simulated user is attached before the
 * promise is returned, so a call placed to a hosted address afterwards is
 * never answered by nobody.
 */
export function simulate(options: SimulateOptions): Promise<Thread> {
  const connection = options.connection as unknown as Connection;
  const user = options.user as unknown as SimulatedUser;
  return run(connection, user, options);
}

async function run(
  connection: Connection,
  user: SimulatedUser,
  options: SimulateOptions,
): Promise<Thread> {
  const maxTurns = options.maxTurns ?? 24;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const renderer = options.renderer ?? noAudio;
  const pacing = options.pacing ?? "none";
  const interruptAfter = options.interruptAfter ?? null;
  const bargeInReactionMs = options.bargeInReactionMs ?? 400;
  const brain = user._makeBrain();
  let expecting: Role = roleOf(options.initiator ?? user._initiator);

  const leg = await connection._bind();
  await leg.ready();
  // Both ends are attached, so the conversation can start.
  leg.begin(connection._direction);

  const turns: Turn[] = [];
  const interruptions: Interruption[] = [];
  const permissions: PermissionRecord[] = [];
  let endReason: EndReason = "maxTurns";

  // The conversation's own clock. Without one every turn happens at the same
  // instant, so nobody is ever mid-utterance and overlap cannot exist.
  let clockMs = 0;
  // Wall-clock second it started, so a turn span is stamped with when it
  // actually happened rather than when it was recorded.
  const startedAt = Date.now() / 1000;
  const wait = (ms: number) =>
    pacing === "realtime" && ms > 0
      ? // Deliberately not unref'd: this timer is the conversation happening,
        // so the process must stay alive for it. The timeout guard below is a
        // safety net and is unref'd, which is the opposite case.
        new Promise<void>((resolve) => setTimeout(resolve, ms))
      : Promise.resolve();

  const record = async (role: Role, text: string, spoken?: AudioFrame) => {
    const audio = spoken ?? (await renderer(text, role));
    const turn = new Turn(role, text, audio ?? null, clockMs);
    turns.push(turn);
    return turn;
  };

  /**
   * Record a finished turn as a span on the conversation's timeline.
   *
   * Stamped with when it happened and how long it lasted rather than opened
   * and closed on the spot: a span that starts and ends in the same instant
   * draws as a zero-width mark, so a nine-second utterance would be invisible
   * on the timeline it is supposed to explain.
   *
   * The span's output is the message, so the thread preprocessor derives the
   * same thread from the trace that the simulation returned directly.
   */
  const stamp = (turn: Turn) => {
    try {
      const parent = currentSpan();
      if (parent === NOOP_SPAN) return;
      const startTime = startedAt + turn.atMs / 1000;
      parent
        .startSpan({
          name: turn.role === "assistant" ? "agent_turn" : "user_turn",
          startTime,
          event: { output: turn.toMessage() },
        })
        .end({ endTime: startTime + turn.durationMs / 1000 });
    } catch {
      // No tracing state. A conversation is still a conversation.
    }
  };

  /**
   * Let a turn play, and hand the floor over when it finishes.
   *
   * With an interruption configured the user starts talking partway through
   * the agent's turn instead. What the agent said past that point was never
   * heard, so the turn is cut to what was played and the overlap is recorded.
   */
  const playOut = async (turn: Turn): Promise<void> => {
    const full = turn.durationMs;
    // Never cut into the opening turn. On an outbound call it carries the
    // whole reason for calling, so talking over it leaves the user with
    // nothing to respond to and the scenario untested.
    const isOpening = turns.indexOf(turn) === 0;
    const cutAt =
      interruptAfter !== null &&
      turn.role === "assistant" &&
      !isOpening &&
      full > 0
        ? Math.round(full * interruptAfter)
        : null;

    if (cutAt === null) {
      await wait(full);
      clockMs += full;
      return;
    }

    // The user starts talking at `cutAt`. The agent does not stop dead: it
    // keeps going for a beat before it notices, and that beat is the overlap,
    // the stretch where both voices are on the line at once.
    const reactionMs = Math.min(bargeInReactionMs, full - cutAt);
    const playedMs = cutAt + reactionMs;

    await wait(playedMs);
    turn._truncate(playedMs);
    interruptions.push({
      by: "user",
      atMs: turn.atMs + cutAt,
      playedMs,
      overlapMs: reactionMs,
    });
    // The user speaks from the moment it cut in, so its audio genuinely lands
    // on top of the agent's last beat.
    clockMs = turn.atMs + cutAt;
  };

  const TIMEOUT = Symbol("timeout");
  const withTimeout = async <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<typeof TIMEOUT>((resolve) => {
        const t = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);

  const messages = () => turns.map((t) => t.toMessage());

  while (turns.length < maxTurns) {
    if (expecting === "user") {
      const said = await brain(turns);
      if (said === null) {
        endReason = turns.length ? "goal" : "hangup";
        break;
      }
      // A user that speaks for itself keeps its own audio; one that does not
      // gets the run's renderer.
      const turn = await record("user", said.text, said.audio ?? undefined);
      await leg.send(said.text, turn.frame());
      await wait(turn.durationMs);
      clockMs += turn.durationMs;
      stamp(turn);
      expecting = "assistant";
    } else {
      const heard = await withTimeout(leg.receive());
      if (heard === TIMEOUT) {
        endReason = "timeout";
        break;
      }
      if (heard === null) {
        endReason = "hangup";
        break;
      }
      // An utterance with nothing in it is not a turn. Recording one puts a
      // blank line in the thread and leaves the other side replying to
      // silence.
      if (!(heard.text ?? "").trim() && !heard.audio) continue;
      if (heard.permissions) permissions.push(...heard.permissions);
      const turn = await record(
        "assistant",
        heard.text ?? "",
        heard.audio ?? undefined,
      );
      await playOut(turn);
      stamp(turn);
      expecting = "user";
    }
  }

  leg.close();
  const summary = summarise(
    turns,
    endReason,
    interruptions,
    permissions,
    options.agent,
  );
  connection._record(summary);
  // Where a scorer reads it, synchronously, with no round trip.
  if (options.hooks) options.hooks.metadata.simulation = summary;
  // And in the trace, for the UI and for anything scoring after the fact.
  recordInTrace(summary);
  return messages();
}

/** The summary on the span, so it survives beyond the run that made it. */
function recordInTrace(summary: Summary): void {
  try {
    const span = currentSpan();
    if (span === NOOP_SPAN) return;
    span.log({ metadata: { simulation: summary } });
  } catch {
    // No tracing state.
  }
}

export { formatThread };
