/**
 * Core types for voice evals.
 *
 * The audio unit is field-for-field compatible with LiveKit's `AudioFrame` and
 * Pipecat's `AudioRawFrame`: signed 16-bit PCM, carrying its own format,
 * because the rate differs between what an agent hears and what it says.
 */

export interface AudioFrame {
  data: Int16Array;
  sampleRate: number;
  numChannels: number;
}

export type Speaker = "agent" | "actor";

/**
 * Where an agent reaches a room, when it is the side placing the call.
 *
 * Not a discriminated union, deliberately. A union is more honest about what
 * is underneath, but it forces every caller to narrow before it can read a
 * URL, which puts transport branching in code that does not care. Instead the
 * accessors are typed as present and throw when the transport cannot offer
 * them, so `room.address.url` reads cleanly and fails loudly.
 */
export interface RoomAddress {
  readonly transport: "websocket" | "phone" | "sip" | "in-process";
  /** A WebSocket or socket URL. Throws unless the transport has one. */
  readonly url: string;
  /** A phone number. Throws unless the transport has one. */
  readonly phoneNumber: string;
  /** A SIP URI. Throws unless the transport has one. */
  readonly uri: string;
}

/** Where the actor places a call to, when the agent is somewhere else. */
export type DialTarget =
  | { url: string }
  | { phoneNumber: string }
  | { uri: string };

/** The wire a room speaks when an agent connects to it. */
export type WireProtocol = "twilio-media-streams";

export interface RoomOptions {
  /**
   * Play each turn at wall-clock speed, so the other side waits for it.
   *
   * Without this a call has no duration, every turn is instantaneous, and
   * nobody is ever mid-utterance, which makes barge-in unmeasurable.
   */
  pacing?: "realtime" | "none";
  /**
   * MOCK ONLY. Have the caller start talking partway through the agent's
   * turns, as a fraction of the way through.
   *
   * A caller decides when to interrupt from its own instructions and from
   * what it is hearing, not on a schedule. This is a stand-in for that
   * decision, so a call can be made to overlap on demand. What is not a
   * stand-in is everything it drives: truncating the agent's turn to what was
   * heard, and reporting the overlap.
   */
  interruptAfter?: number;
  /**
   * MOCK ONLY. How long the agent keeps talking after the caller cuts in,
   * before it notices and stops.
   *
   * This is the agent's characteristic, not the caller's and not the line's,
   * and we do not control the agent under test. A real call gets whatever
   * reaction time the agent has. It exists here because a simulated call has
   * to model it from somewhere, and without it the two turns abut instead of
   * overlapping. Not part of the API a customer would use.
   */
  bargeInReactionMs?: number;
  /** The wire to speak for a bridged agent. */
  protocol?: WireProtocol;
  /**
   * Take turns explicitly rather than by voice detection. The only mode
   * implemented here, and the reason a run is reproducible.
   */
  turnTaking?: "deterministic";
  /** How a turn's audio is produced. Omit for text only. */
  renderer?: VoiceRenderer;
}

export interface ListenOptions {
  timeoutMs?: number;
  maxTurns?: number;
}

export interface DialOptions extends RoomOptions {
  timeoutMs?: number;
}

/** How a turn's audio is produced. Returning null keeps the turn text-only. */
export type VoiceRenderer = (
  text: string,
  speaker: Speaker,
) => Promise<AudioFrame | null>;

/** One party speaking over the other. */
export interface Interruption {
  /** Who started talking over whom. */
  by: Speaker;
  /** When, in milliseconds from the start of the call. */
  atMs: number;
  /** How much of the interrupted turn the other side actually heard. */
  playedMs?: number;
  /** How long the two overlapped. Zero is a real and useful answer. */
  overlapMs: number;
}

export type EndReason = "hangup" | "goal" | "timeout" | "maxTurns";
