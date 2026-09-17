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
  by: Speaker;
  atMs: number;
  playedMs?: number;
}

export type EndReason = "hangup" | "goal" | "timeout" | "maxTurns";
