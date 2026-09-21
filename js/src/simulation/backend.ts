/**
 * Where actors come from.
 *
 * Today there is no hosted actor service, so a labelled local fake reads from
 * a script. `VoiceBackend` is the interface a real one implements, and it is
 * the only thing that changes when it arrives.
 */

import { SimulatedUser, UserBrain } from "./simulate";

import { heard, speak, wavToFrame, type SpeechOptions } from "./speech";
import { Initiator } from "./types";
import { pcmToWav } from "./wav";

/** An `AudioFrame` as a WAV, so a model can hear it. */
function frameToWav(frame: {
  data: Int16Array;
  sampleRate: number;
  numChannels: number;
}) {
  return pcmToWav(frame.data, {
    sampleRate: frame.sampleRate,
    numChannels: frame.numChannels,
  });
}

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
export interface SimulatedUserDefinition {
  slug: string;
  /** Who they are and how they behave. The model's system prompt. */
  persona: string;
  /** What they are trying to achieve on this call. */
  goal: string;
  /** Who this persona expects to start the conversation. */
  initiator?: Initiator;
  /** How they sound. Carried now, applied once the audio is real. */
  voice?: { name?: string; accent?: string };
  /** What the line does to them: background noise, degradation. */
  filters?: { backgroundNoise?: string; lineNoise?: number };
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

/**
 * What varies from one run of a persona to the next.
 *
 * Layered over the persona, last value winning, so a variation costs a
 * parameter rather than a whole new persona. Usually these come from the
 * dataset row, which is what makes one persona serve every case.
 */
export interface SimulatedUserParams {
  /**
   * What is true this run: the order number, the name on the account.
   *
   * Handed over as data rather than spliced into the persona's text, so a
   * model-driven user draws on them the way it would on a tool result.
   */
  facts?: Record<string, unknown>;
  persona?: string;
  goal?: string;
  voice?: { name?: string; accent?: string };
  filters?: { backgroundNoise?: string; lineNoise?: number };
}

export interface SimulationBackend {
  readonly name: string;
  getSimulatedUser(
    slug: string,
    params?: SimulatedUserParams,
  ): Promise<SimulatedUser>;
}

/** The persona with this run's parameters on top. Last value wins. */
function layer(
  definition: SimulatedUserDefinition,
  params: SimulatedUserParams = {},
): SimulatedUserDefinition & { facts: Record<string, unknown> } {
  return {
    ...definition,
    persona: params.persona ?? definition.persona,
    goal: params.goal ?? definition.goal,
    voice: params.voice ?? definition.voice,
    filters: params.filters ?? definition.filters,
    facts: params.facts ?? {},
  };
}

/** The one place a `{{name}}` in a scripted line is filled in. */
function fill(line: string, facts: Record<string, unknown>): string {
  return line.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) =>
    key in facts ? String(facts[key]) : whole,
  );
}

/** @deprecated Use {@link SimulationBackend}. */
export type VoiceBackend = SimulationBackend;

let configured: SimulationBackend | null = null;

export function configureSimulation(backend: SimulationBackend): void {
  configured = backend;
}

/** @internal */
export function activeBackend(): SimulationBackend {
  if (!configured) {
    throw new Error(
      "No simulation backend configured. Call configureSimulation(...) " +
        "first, for example configureSimulation(scriptedUsers({ users })).",
    );
  }
  return configured;
}

/** @internal Test helper. */
export function resetSimulationForTesting(): void {
  configured = null;
}

/**
 * LABELLED FAKE. Simulated users that read their lines instead of deciding them.
 *
 * What is faked: the simulated user's brain, and only its brain. What is NOT faked: the
 * agent, which answers for real over a real socket, so its replies are its own
 * and a side-effect scorer reflects what it actually did.
 */
export function scriptedUsers(opts: {
  users: SimulatedUserDefinition[];
}): SimulationBackend {
  const actors = new Map(opts.users.map((a) => [a.slug, a]));
  return {
    name: "scripted",
    async getSimulatedUser(
      slug: string,
      params?: SimulatedUserParams,
    ): Promise<SimulatedUser> {
      const found = actors.get(slug);
      if (!found) {
        throw new Error(
          `No simulated user "${slug}". Known: ` +
            `${[...actors.keys()].join(", ") || "(none)"}.`,
        );
      }
      const definition = layer(found, params);
      // A fixed line cannot draw on a fact the way a model can, so here, and
      // only here, a fact reaches the conversation by filling a `{{name}}`.
      // That is a property of the stand-in brain, not of the API.
      const script = definition.script.map((line) =>
        fill(line, definition.facts),
      );
      const makeBrain = (): UserBrain => {
        let next = 0;
        return async () =>
          next < script.length ? { text: script[next++] } : null;
      };
      return new SimulatedUser(
        slug,
        makeBrain,
        definition.initiator ?? "agent",
      );
    },
  };
}

/**
 * Simulated users that are themselves voice agents.
 *
 * Each turn is one speech-native model call: the actor hears the agent's audio,
 * decides what to say from its persona and goal, and speaks. Nothing is
 * scripted, so what it says varies between runs the way a caller's would.
 *
 * `script` on an {@link SimulatedUserDefinition} is ignored here. That field is the
 * thing this replaces.
 */
export function voiceUsers(opts: {
  users: SimulatedUserDefinition[];
  speech?: SpeechOptions;
  /** Hang up after this many of the simulated user's own turns. */
  maxTurns?: number;
}): SimulationBackend {
  const actors = new Map(opts.users.map((a) => [a.slug, a]));
  const maxTurns = opts.maxTurns ?? 6;

  return {
    name: "voice",
    async getSimulatedUser(
      slug: string,
      params?: SimulatedUserParams,
    ): Promise<SimulatedUser> {
      const found = actors.get(slug);
      if (!found) {
        throw new Error(
          `No simulated user "${slug}". Known: ` +
            `${[...actors.keys()].join(", ") || "(none)"}.`,
        );
      }
      const definition = layer(found, params);

      // Saying goodbye does not end a call. Without an explicit way to hang
      // up, two polite agents will exchange farewells until a turn limit
      // stops them, which reads as a broken call rather than a finished one.
      const endCall = [
        {
          type: "function",
          function: {
            name: "end_call",
            description:
              "Hang up the phone. This is the only way to end the call; " +
              "saying goodbye does not end it. Call it as soon as your goal " +
              "is achieved, or as soon as it is clear it cannot be. A short " +
              "goodbye may be spoken in the same turn.",
            parameters: {
              type: "object",
              properties: {
                success: {
                  type: "boolean",
                  description: "Whether the goal was achieved.",
                },
              },
              required: ["success"],
            },
          },
        },
      ];

      const instruction =
        `You are playing a person on a phone call with a voice agent. Stay in ` +
        `character; never mention being simulated or an AI.\n\n` +
        `Who you are: ${definition.persona}\n\n` +
        `What you want from this call: ${definition.goal}\n\n` +
        (definition.voice?.accent
          ? `You speak with a ${definition.voice.accent} accent.\n\n`
          : "") +
        (definition.filters?.backgroundNoise
          ? `You are calling from: ${definition.filters.backgroundNoise}.\n\n`
          : "") +
        // Listed, not narrated: these are things the person knows, the same
        // way they would know their own order number before dialling.
        (Object.keys(definition.facts).length
          ? `What you know going in:\n` +
            Object.entries(definition.facts)
              .map(([key, value]) => `- ${key}: ${String(value)}`)
              .join("\n") +
            `\n\n`
          : "") +
        `Reply with one short spoken turn, in the first person, as a real ` +
        `caller would. When your goal is met or it is clear it cannot be, say ` +
        `a brief goodbye and then say nothing further.`;

      const makeBrain = (): UserBrain => {
        let spoken = 0;
        return async (history) => {
          if (spoken >= maxTurns) return null;
          // end_call is only offered once there has been an exchange, or an
          // eager actor hangs up before it has heard anything.
          const mayHangUp = spoken >= 1;

          // What the actor said is remembered as text; what it heard is
          // replayed as audio, so its half of the call crosses real speech.
          const messages: unknown[] = [
            { role: "system", content: instruction },
          ];
          for (const turn of history) {
            if (turn.role === "user") {
              messages.push({ role: "assistant", content: turn.text });
              continue;
            }
            const frame = turn.frame();
            messages.push(
              frame
                ? { role: "user", content: [heard(frameToWav(frame))] }
                : { role: "user", content: turn.text },
            );
          }
          if (history.length === 0) {
            messages.push({
              role: "user",
              content: "(the line connects, and the other side is silent)",
            });
          }

          const said = await speak(messages, {
            ...opts.speech,
            // How an actor sounds is part of who they are, so it comes from
            // the definition rather than from whoever configured the backend.
            ...(definition.voice?.name ? { voice: definition.voice.name } : {}),
            ...(mayHangUp ? { tools: endCall } : {}),
          });
          spoken++;
          if (said.toolCalls.some((c) => c.name === "end_call")) return null;
          const text = said.text.trim();
          if (!text) return null;
          return {
            text,
            audio: said.wav ? wavToFrame(said.wav) : null,
          };
        };
      };

      return new SimulatedUser(
        slug,
        makeBrain,
        definition.initiator ?? "agent",
      );
    },
  };
}
