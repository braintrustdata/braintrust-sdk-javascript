/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
// Structural boundaries intentionally avoid a runtime dependency on LiveKit/OTel.
import { debugLogger } from "../../debug-logger";
import type {
  AgentSession,
  AgentActivity,
  EndOfTurnInfo,
  ChatMessage,
  AudioFrame,
} from "./types";
import type { AudioExtension, Recording } from "./audio";
import type { Span } from "../../logger";
import type { Message } from "./schema";
import type { LiveKitOptions } from "./options";

export type NativeSpan = {
  name: string;
  spanContext(): { spanId: string; traceId: string; traceFlags?: number };
  parentSpanContext?: { spanId: string };
  parentSpanId?: string;
  startTime: [number, number];
  endTime: [number, number];
  attributes: Record<string, any>;
  events: {
    name: string;
    time: [number, number];
    attributes?: Record<string, any>;
  }[];
  status: { code: number; message?: string };
};
export type { Packet } from "./audio";
import type { Selection } from "./audio";
export type { Selection } from "./audio";
export type Row = {
  span: Span;
  native: Pick<NativeSpan, "name" | "spanContext">;
  parent?: string;
  turn?: string;
  session?: string;
  ended?: boolean;
  folded?: boolean;
  replyTo?: string;
  messages?: Map<string, Message>;
};
export type Capture = {
  session: any;
  row: Row;
  user: boolean;
  agent: boolean;
  origin: number;
  recording: Recording;
  timeline: AudioExtension["timeline"];
  inputTimeline: {
    at: number;
    duration: number;
    rate: number;
    channels: number;
    sampleStart: number;
  }[];
  inputDurationMs: number;
  outputHolds: Map<object, number>;
  frameCount?: number;
  inputEnd?: number;
  inputStream?: object;
  closed: boolean;
  selections: Map<string, Selection[]>;
  events: Map<string, any[]>;
  externalSpans?: Map<string, Span>;
  cleanups: (() => void)[];
  finish?: Promise<void>;
  publishSelections?: () => void;
};
interface LiveKitRuntime {
  automatic?: boolean;
  rows: Map<string, Row>;
  captures: WeakMap<object, Capture>;
  begin(session: AgentSession): void;
  realtime(
    activity: AgentActivity,
    generation?: {
      ev?: { responseId?: string };
      inferenceSpan?: NativeSpan;
      span?: NativeSpan;
    },
  ): void;
  input(activity: AgentActivity, stream: ReadableStream<AudioFrame>): void;
  output(session: AgentSession): void;
  userTurn(activity: AgentActivity, info: EndOfTurnInfo): void;
  finish(session: AgentSession): Promise<void>;
  conversation(session: AgentSession, item: ChatMessage): void;
  scope<T>(span: any, fn: () => T): T;
  inference<T>(fn: () => T): T;
}
const key = Symbol.for("braintrust.livekit.runtime");
export function runtime(): LiveKitRuntime | undefined {
  return (globalThis as any)[key];
}
export function installRuntime(value: LiveKitRuntime): () => void {
  if (runtime())
    throw new Error("Only one LiveKitSpanProcessor may be active per process");
  (globalThis as any)[key] = value;
  return () => {
    if (runtime() === value) delete (globalThis as any)[key];
  };
}
export function observe(fn: () => void): void {
  try {
    fn();
  } catch {
    debugLogger.debug("LiveKit instrumentation observation failed");
  }
}
export const nativeId = (span: any): string | undefined =>
  span?.spanContext?.().spanId;
export const seconds = (time: [number, number]) => time[0] + time[1] / 1e9;
export const nativeFields = (fields: Record<string, any> = {}) =>
  Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k.startsWith("lk.") ? `contrib.livekit.${k.slice(3)}` : k,
      v,
    ]),
  );

// The Node entrypoint supplies platform-specific setup without extending the
// core isomorphic interface with integration-specific operations.
type Prepare = (
  tracer: unknown,
  options: LiveKitOptions,
  allowContent: boolean,
) => boolean;
const prepareKey = Symbol.for("braintrust.livekit.prepare");
export function setPreparation(prepare: Prepare): void {
  (globalThis as any)[prepareKey] = prepare;
}
export function prepare(
  tracer: unknown,
  options: LiveKitOptions,
  allowContent: boolean,
): boolean {
  const setup: Prepare | undefined = (globalThis as any)[prepareKey];
  return setup?.(tracer, options, allowContent) ?? false;
}
