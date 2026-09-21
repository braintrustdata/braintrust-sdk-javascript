/**
 * Simulations.
 *
 * A simulation is one simulated user talking to one agent over one
 * connection, and it produces a thread: the same `{ role, content }` messages
 * any multi-turn eval already produces. Scorers read that thread as
 * `args.output` the way they read any task output, so nothing about `Eval`
 * changes and there is no simulation-specific scorer type.
 *
 *   connect({ via })   the agent is waiting somewhere
 *   host({ via })      the agent will arrive, so stand an interface up
 *   simulate({ ... })  run it, and resolve to the thread
 *
 * @module
 */

export { connect, host, Connection } from "./connection";
export { Call } from "./call";
export {
  simulate,
  SimulatedUser,
  noAudio,
  formatThread,
  type UserBrain,
  type Utterance,
} from "./simulate";
export { textOf, audioOf, Turn } from "./thread";
export {
  configureSimulation,
  resetSimulationForTesting,
  scriptedUsers,
  voiceUsers,
  activeBackend,
  type SimulatedUserDefinition,
  type SimulatedUserParams,
  type SimulationBackend,
  type VoiceBackend,
} from "./backend";
export {
  speak,
  heard,
  wavToFrame,
  DEFAULT_SPEECH_MODEL,
  type SpeechOptions,
  type SpeechTurn,
} from "./speech";
export { resolveFakeNumber, clearFakeNumbers } from "./phone";
export { makeAddress } from "./address";
export { audioFilename, pcmToWav, placeholderTone } from "./wav";
export { placeholderAudio } from "./render";
export type {
  Address,
  AcpTarget,
  AudioFrame,
  ConnectOptions,
  ContentPart,
  EndReason,
  EvalHooksLike,
  HostInterface,
  HostOptions,
  Initiator,
  Interruption,
  Message,
  MessageMetadata,
  PermissionRecord,
  Role,
  SimulateOptions,
  Summary,
  Target,
  Thread,
  VoiceRenderer,
} from "./types";

import { activeBackend, type SimulatedUserParams } from "./backend";
import { SimulatedUser } from "./simulate";

/**
 * Retrieves a simulated user, with this run's parameters layered over it.
 *
 * Defining a persona is not part of this surface.
 */
export async function getSimulatedUser(
  slug: string,
  params?: SimulatedUserParams,
): Promise<SimulatedUser> {
  return activeBackend().getSimulatedUser(slug, params);
}
