/**
 * Core types for simulations.
 *
 * A simulation is one simulated user talking to one agent over one connection,
 * and what it produces is a thread: the same `{ role, content }` messages any
 * multi-turn eval in Braintrust already produces.
 */

import { Attachment } from "../logger";

export interface AudioFrame {
  data: Int16Array;
  sampleRate: number;
  numChannels: number;
}

/** The agent under test is `assistant`. The simulated user is `user`. */
export type Role = "assistant" | "user";

/**
 * Who starts the conversation.
 *
 * Domain language rather than the thread's roles: a customer talks about
 * their agent, not about an assistant. `agent` is the participant whose turns
 * are recorded with `role: "assistant"`.
 */
export type Initiator = "agent" | "user";

// ---------------------------------------------------------------- the thread

/** Text, or audio carried as a handle rather than as bytes. */
export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "input_audio";
      input_audio: { data: Attachment; format: "wav" };
    };

/** Where a turn sits on the conversation's timeline. */
export interface MessageMetadata {
  at_ms: number;
  duration_ms: number;
  /** Present when the other party cut in and the rest was never heard. */
  truncated_at_ms?: number;
}

/**
 * One turn.
 *
 * Deliberately the shape `trace.getThread()` already returns, so a scorer
 * written against a text agent works against a simulated one unchanged.
 */
export interface Message {
  role: Role;
  content: ContentPart[];
  metadata?: MessageMetadata;
}

export type Thread = Message[];

// ------------------------------------------------------------ the connection

/** Which interface to stand up, when the agent is the side that arrives. */
export type HostInterface =
  | "websocket"
  | "phone"
  | "sip"
  | "livekit"
  | "twilio-media-streams";

/**
 * Where a waiting agent is.
 *
 * The key names the interface, so nothing is inferred from the value. Its
 * value is the coordinate, or an object where an interface needs more than
 * one thing.
 */
export type Target =
  | { websocket: string }
  | { phone: string }
  | { sip: string }
  | { livekit: { url: string; token: string } }
  | { acp: AcpTarget };

export interface AcpTarget {
  /** The command that speaks ACP on stdio. */
  command: string;
  /** How an unattended run answers an agent that asks to proceed. Denies by default. */
  permissions?: "allow" | "deny";
  /**
   * What to send to make an agent that greets first speak.
   *
   * ACP has no unprompted agent turn, so `initiator: "agent"` is the client
   * asking. It is the nudge, not the greeting, and it stays out of the thread.
   */
  opening?: string;
}

export interface ConnectOptions {
  via: Target;
  /** How long to wait for the agent to pick up. */
  timeoutMs?: number;
}

export interface HostOptions {
  via?: HostInterface;
}

/**
 * Where the agent reaches a hosted connection.
 *
 * Not a discriminated union, deliberately. Every accessor is typed as present
 * and throws when the interface has nothing to offer, so handing an address
 * out never means narrowing a type first.
 */
export interface Address {
  readonly interface: HostInterface | "in-process" | "acp";
  readonly url: string;
  readonly phoneNumber: string;
  readonly uri: string;
  /** What was spawned, on a connection whose agent is a process. */
  readonly command: string;
}

// ------------------------------------------------------------ the simulation

export type EndReason = "hangup" | "goal" | "timeout" | "maxTurns";

/** One party talking over the other. */
export interface Interruption {
  by: Role;
  atMs: number;
  /** How much of the interrupted turn the other side actually heard. */
  playedMs?: number;
  /** How long the two overlapped. Zero is a real and useful answer. */
  overlapMs: number;
}

/** That a policy rather than a person answered an agent that asked. */
export interface PermissionRecord {
  request: string;
  decision: string;
}

/** How the conversation went. Recorded as `metadata.simulation` on the row. */
export interface Summary {
  /** What the agent under test was called, when the simulation named it. */
  agent?: string;
  endReason: EndReason;
  durationMs: number;
  interruptions: Interruption[];
  /** The whole conversation as one stereo recording, user left, agent right. */
  audio: Attachment | null;
  permissions: PermissionRecord[];
}

/** How a turn's audio is produced. Returning null keeps the turn text only. */
export type VoiceRenderer = (
  text: string,
  role: Role,
) => Promise<AudioFrame | null>;

/**
 * The eval's hooks, as much of them as a simulation uses.
 *
 * Structural, so the framework's `EvalHooks` satisfies it without this module
 * importing the framework. Taking the whole object rather than just its
 * metadata leaves room to report progress per turn later without changing a
 * signature customers have already written against.
 */
export interface EvalHooksLike {
  metadata: Record<string, any>;
  reportProgress?: (event: any) => void;
}

export interface SimulateOptions {
  // Who is in the conversation.

  /** The simulated user. */
  user: SimulatedUserHandle;
  /**
   * What to call the agent under test, in the record of this simulation.
   *
   * We can resolve the simulated user because we own it. We can only ever
   * name the agent, because it is the customer's and opaque to us by design.
   */
  agent?: string;
  /** Who starts the conversation. */
  initiator?: Initiator;

  // How they are connected, and where the record goes.

  /** The connection the two of them talk over. */
  connection: ConnectionHandle;
  /**
   * The eval's hooks, so the summary reaches a scorer without a round trip.
   *
   * Passed rather than found: a row's metadata reaches the task and nothing
   * deeper, and a library that reached up the stack to mutate it would be
   * invisible at the call site.
   */
  hooks?: EvalHooksLike;

  // How the run behaves.

  /**
   * Play each turn at wall-clock speed, so the other side waits for it.
   *
   * Without it nobody is ever mid-utterance, so barge-in cannot be measured.
   * Audio only: a real line ignores it, being real time already.
   */
  pacing?: "realtime" | "none";
  /**
   * MOCK ONLY. Have the user start talking partway through the agent's turns.
   *
   * A real caller decides when to interrupt from what it is hearing, not on a
   * schedule. This is a stand-in for that decision so a conversation can be
   * made to overlap on demand. What it drives is not a stand-in: truncating
   * the agent's turn to what was heard, and reporting the overlap.
   */
  interruptAfter?: number;
  /**
   * MOCK ONLY. How long the agent keeps talking after being cut into.
   *
   * The agent's characteristic, not the line's, and we do not control the
   * agent under test. Without it the two turns abut instead of overlapping.
   */
  bargeInReactionMs?: number;
  /** How a turn's audio is produced. Omit for text only. */
  renderer?: VoiceRenderer;
  timeoutMs?: number;
  maxTurns?: number;
}

/** @internal Structural placeholders, so types.ts imports nothing circular. */
export interface ConnectionHandle {
  readonly address: Address;
}
export interface SimulatedUserHandle {
  readonly slug: string;
}
