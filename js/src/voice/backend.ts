/**
 * Where actors come from.
 *
 * Today there is no hosted actor service, so a labelled local fake reads from
 * a script. `VoiceBackend` is the interface a real one implements, and it is
 * the only thing that changes when it arrives.
 */

import { Actor } from "./actor";
import { ActorBrain } from "./room";
import { Speaker } from "./types";

/**
 * An actor, as data.
 *
 * An actor is itself a voice agent: it plays the person calling the agent
 * under test, decides what to say from a prompt and a goal, and speaks over
 * audio. It is not deterministic, and we do not own the thing that runs it.
 *
 * Data rather than code on purpose. A persona written as a subclass can never
 * be produced from a production recording, and one written as data can.
 */
export interface ActorDefinition {
  slug: string;
  /** Who they are and how they behave. The model's system prompt. */
  persona: string;
  /** What they are trying to achieve on this call. */
  goal: string;
  /** Who opens the call. */
  speaksFirst?: Speaker;
  /** How they sound. Carried now, applied once the audio is real. */
  voice?: { name?: string; accent?: string };
  /** What the line does to them: background noise, degradation. */
  conditions?: { backgroundNoise?: string; lineNoise?: number };
  /**
   * PASS 1 STAND-IN. Fixed lines, in order, instead of a model deciding.
   *
   * This is the one field that goes away: replace it with a call to a voice
   * model driven by `persona` and `goal`, and nothing else about an actor, a
   * room, or a scorer changes. Keeping it makes a run free and repeatable,
   * which a real actor is not.
   */
  script: string[];
}

/** @deprecated Use {@link ActorDefinition}. */
export type ScriptedActor = ActorDefinition;

export interface VoiceBackend {
  readonly name: string;
  getActor(slug: string): Promise<Actor>;
}

let configured: VoiceBackend | null = null;

export function configureVoice(backend: VoiceBackend): void {
  configured = backend;
}

/** @internal */
export function activeBackend(): VoiceBackend {
  if (!configured) {
    throw new Error(
      "No voice backend configured. Call configureVoice(...) first, for " +
        "example configureVoice(scriptedActors({ actors })).",
    );
  }
  return configured;
}

/** @internal Test helper. */
export function resetVoiceForTesting(): void {
  configured = null;
}

/**
 * LABELLED FAKE. Actors that read their lines instead of deciding them.
 *
 * What is faked: the actor's brain, and only its brain. What is NOT faked: the
 * agent, which answers for real over a real socket, so its replies are its own
 * and a side-effect scorer reflects what it actually did.
 */
export function scriptedActors(opts: {
  actors: ActorDefinition[];
}): VoiceBackend {
  const actors = new Map(opts.actors.map((a) => [a.slug, a]));
  return {
    name: "scripted",
    async getActor(slug: string): Promise<Actor> {
      const definition = actors.get(slug);
      if (!definition) {
        throw new Error(
          `No actor "${slug}". Known actors: ` +
            `${[...actors.keys()].join(", ") || "(none)"}.`,
        );
      }
      const makeBrain = (): ActorBrain => {
        let next = 0;
        return async () =>
          next < definition.script.length ? definition.script[next++] : null;
      };
      return new Actor(slug, makeBrain, definition.speaksFirst ?? "agent");
    },
  };
}
