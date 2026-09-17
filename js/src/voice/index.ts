/**
 * Voice evals.
 *
 * A voice eval is an ordinary eval whose task holds a phone call. The task
 * connects the agent, puts a simulated caller on the other end, waits for the
 * call to finish, and returns the `Conversation`. Scorers read it as
 * `args.output` the way they read any other task output, so nothing about
 * `Eval` changes and there is no voice-specific scorer type.
 *
 * Either the caller dials the agent or the agent dials the caller:
 *
 *   Calls to the agent      `actor.dial(address)`
 *   Calls from the agent    `actor.waitForCall()`, then hand out `room.address`
 *   Agent in this process   `newRoom()` plus `room.onIncomingCall(...)`
 *
 * @module
 */

import { buildRoom } from "./actor";
import { activeBackend } from "./backend";
import { Actor } from "./actor";
import { Room } from "./room";
import { RoomOptions } from "./types";

/** Creates and returns a `Room` for voice chat. */
export async function newRoom(
  options: RoomOptions & { transport?: "websocket" | "phone" | "sip" } = {},
): Promise<Room> {
  return buildRoom(options);
}

/** Retrieves an `Actor`. */
export async function getActor(slug: string): Promise<Actor> {
  return activeBackend().getActor(slug);
}

export {
  configureVoice,
  resetVoiceForTesting,
  scriptedActors,
  voiceActors,
  type ActorDefinition,
  type ScriptedActor,
  type VoiceBackend,
} from "./backend";
export { Actor } from "./actor";
export { Call, Room, noAudio, type ActorBrain, type Utterance } from "./room";
export {
  speak,
  heard,
  wavToFrame,
  DEFAULT_SPEECH_MODEL,
  type SpeechOptions,
  type SpeechTurn,
} from "./speech";
export { Conversation, VoiceTurn } from "./conversation";
export { resolveFakeNumber, clearFakeNumbers } from "./phone";
export { makeAddress } from "./address";
export { audioFilename, pcmToWav, placeholderTone } from "./wav";
export { placeholderAudio } from "./render";
export type {
  AudioFrame,
  DialOptions,
  DialTarget,
  EndReason,
  Interruption,
  ListenOptions,
  RoomAddress,
  RoomOptions,
  Speaker,
  VoiceRenderer,
  WireProtocol,
} from "./types";
