/**
 * The room, the call, and the turn loop.
 *
 * A `Room` is one call, with an actor on one end and an agent on the other.
 * The room owns both ends: it connects, carries the audio, tracks turns, and
 * decides when the call is over. What varies is only how the agent's end is
 * attached, which is what `AgentLeg` abstracts.
 */

import { currentSpan, NOOP_SPAN } from "../logger";
import { Conversation, VoiceTurn } from "./conversation";
import { AgentLeg, InProcessLeg, Slot, ClientLeg, ServerLeg } from "./legs";
import {
  AudioFrame,
  EndReason,
  Interruption,
  ListenOptions,
  RoomAddress,
  RoomOptions,
  Speaker,
  VoiceRenderer,
} from "./types";

/** What one party says in one turn. */
export interface Utterance {
  text: string;
  audio?: AudioFrame | null;
}

/**
 * Decides what the actor says next. Null hangs up.
 *
 * A scripted actor returns text and lets the room render it. A voice-native
 * actor returns the audio it actually produced, and the text is that audio's
 * own transcript rather than a script the audio was made from.
 */
export type ActorBrain = (
  history: ReadonlyArray<VoiceTurn>,
) => Promise<Utterance | null>;

export const noAudio: VoiceRenderer = async () => null;

/**
 * The agent's handle on an in-process call.
 *
 * Only used by the appendix shortcut. Nothing on a dial-in or bridged call
 * touches this, because there the wire is real and the room owns it.
 */
export class Call {
  constructor(private readonly leg: InProcessLeg) {}

  /** Wait for the caller to say something. Null when the call is over. */
  async listen(): Promise<string | null> {
    const heard = await this.leg.toAgent.take();
    return heard ? heard.text : null;
  }

  /** Frames the agent hears. */
  get audio(): ReadableStream<AudioFrame> {
    const leg = this.leg;
    return new ReadableStream<AudioFrame>({
      async pull(controller) {
        const heard = await leg.toAgent.take();
        if (!heard) return controller.close();
        if (heard.audio) controller.enqueue(heard.audio);
      },
    });
  }

  /** Frames the agent speaks. */
  async sendAudio(frame: AudioFrame): Promise<void> {
    this.leg.toRoom.put({ text: "", audio: frame });
  }

  /** The text tier, for running a case without speech. */
  async say(text: string): Promise<void> {
    this.leg.toRoom.put({ text, audio: null });
  }

  /**
   * Barge-in. `playedMs` is how much the caller actually heard, and is
   * optional because not every transport can report it.
   */
  cancelOutput(_playedMs?: number): void {
    // Nothing is buffered in-process, so there is nothing to discard.
  }

  hangUp(): void {
    this.leg.toRoom.put(null);
  }
}

export interface RoomInit {
  id: string;
  options: RoomOptions;
  /** Supplied up front by Actor.dial(target), or at dial time for a room. */
  brain?: ActorBrain;
  /** Who opens the call. */
  speaksFirst?: Speaker;
  leg: AgentLeg;
  address: RoomAddress;
  /** Which way the call goes, from the agent's point of view. */
  direction?: "inbound" | "outbound";
}

/** Where a call happens. */
export class Room {
  readonly id: string;
  readonly address: RoomAddress;
  private brain: ActorBrain | null;
  private speaksFirst: Speaker;
  private readonly renderer: VoiceRenderer;
  private readonly leg: AgentLeg;
  private direction: "inbound" | "outbound";
  private agentTask: Promise<void> | null = null;

  constructor(init: RoomInit) {
    this.id = init.id;
    this.address = init.address;
    this.brain = init.brain ?? null;
    this.speaksFirst = init.speaksFirst ?? "agent";
    this.renderer = init.options.renderer ?? noAudio;
    this.leg = init.leg;
    this.direction = init.direction ?? "inbound";
  }

  /** @internal An actor brings its script with it when it dials in. */
  _attach(brain: ActorBrain, speaksFirst: Speaker): void {
    this.brain = brain;
    this.speaksFirst = speaksFirst;
  }

  /**
   * Hand a `Call` to an agent running in this process.
   *
   * The appendix shortcut. Throws on a room whose agent is reachable over a
   * wire, because there is nothing to hand over.
   */
  onIncomingCall(handler: (call: Call) => Promise<void> | void): void {
    if (!(this.leg instanceof InProcessLeg)) {
      throw new Error(
        "onIncomingCall() is only for an agent running in this process. " +
          "This room reaches its agent over a wire, so there is no Call to " +
          "hand over.",
      );
    }
    const call = new Call(this.leg);
    this.agentTask = Promise.resolve(handler(call)).then(
      () => this.leg.close(),
      (err) => {
        this.leg.close();
        throw err;
      },
    );
  }

  /** Wait until the conversation ends, then return it. */
  async listen(opts: ListenOptions = {}): Promise<Conversation> {
    const maxTurns = opts.maxTurns ?? 24;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const brain = this.brain;
    if (!brain) {
      throw new Error(
        "This room has no caller. Have an actor dial() into it before " +
          "calling listen().",
      );
    }
    await this.leg.ready();
    // Both ends are attached, so the call can start.
    this.leg.begin(this.direction);

    const turns: VoiceTurn[] = [];
    const interruptions: Interruption[] = [];
    let endReason: EndReason = "maxTurns";

    const record = async (
      speaker: Speaker,
      text: string,
      spoken?: AudioFrame,
    ) => {
      const audio = spoken ?? (await this.renderer(text, speaker));
      const turn = new VoiceTurn(speaker, text, audio);
      turns.push(turn);
      // A turn primitive, so the call reads as a timeline rather than a pile
      // of spans. Matches the shape our LiveKit and Pipecat integrations emit.
      try {
        const parent = currentSpan();
        if (parent !== NOOP_SPAN) {
          parent
            .startSpan({
              name: speaker === "agent" ? "agent_turn" : "user_turn",
              event: { output: turn.toJSON() },
            })
            .end();
        }
      } catch {
        // No tracing state. A call is still a call.
      }
      return turn;
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

    let expecting: Speaker = this.speaksFirst;

    while (turns.length < maxTurns) {
      if (expecting === "actor") {
        const said = await brain(turns);
        if (said === null) {
          endReason = turns.length ? "goal" : "hangup";
          break;
        }
        // An actor that speaks for itself keeps its own audio; one that does
        // not gets the room's renderer.
        const turn = await record("actor", said.text, said.audio ?? undefined);
        await this.leg.send(said.text, turn.frame());
        expecting = "agent";
      } else {
        const heard = await withTimeout(this.leg.receive());
        if (heard === TIMEOUT) {
          endReason = "timeout";
          break;
        }
        if (heard === null) {
          endReason = "hangup";
          break;
        }
        await record("agent", heard.text, heard.audio ?? undefined);
        expecting = "actor";
      }
    }

    this.leg.close();
    if (this.agentTask) {
      await Promise.race([
        this.agentTask.catch(() => {}),
        new Promise<void>((r) => {
          const t = setTimeout(r, 1000);
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
    }
    return new Conversation(turns, endReason, interruptions);
  }
}

export { InProcessLeg, ClientLeg, ServerLeg, Slot };
