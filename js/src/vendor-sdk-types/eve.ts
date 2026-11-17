/**
 * Vendored types for eve's instrumentation provider API, introduced in 0.34.0.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and should only cover fields the Braintrust provider reads or returns.
 */

export type EveJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EveJsonValue[]
  | { readonly [key: string]: EveJsonValue };

export interface EveInstrumentationState {
  get(): EveJsonValue | undefined;
  set(value: EveJsonValue | undefined): void;
}

export interface EveInstrumentationHandlerContext {
  readonly state: EveInstrumentationState;
}

export interface EveInstrumentationSetupContext {
  readonly agentName: string;
  readonly environment?: "development" | "preview" | "production";
  readonly evaluation?: { readonly runId: string };
  readonly frameworkVersion?: string;
}

export type EveInstrumentationAttemptScope = {
  readonly functionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  // Eve 1.x also runs model calls (for example compaction) outside a turn.
  readonly turnId?: string;
} & (
  | {
      readonly attemptId: string;
      readonly attemptIndex: number;
      readonly stepIndex: number;
    }
  | { readonly runId: string; readonly attempt: number }
);

export interface EveInstrumentationParentLineage {
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface EveInstrumentationTraceContext {
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}

export interface EveInstrumentationUsage {
  readonly costUsd?: number;
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface EveInstrumentationModelInput {
  readonly instructions?: unknown;
  readonly messages: readonly unknown[];
  readonly tools?: readonly unknown[];
}

export type EveInstrumentationContentPart =
  | {
      readonly text: string;
      readonly type: "text";
    }
  | {
      readonly text: string;
      readonly type: "reasoning";
    }
  | {
      readonly callId: string;
      readonly input: unknown;
      readonly toolName: string;
      readonly type: "tool-call";
    }
  | {
      readonly type: "tool-result";
    }
  | {
      readonly type: "tool-error";
    };

export interface EveInstrumentationTurnStartedEvent {
  readonly idempotencyKey: string;
  readonly parentLineage?: EveInstrumentationParentLineage;
  readonly parentTraceContext?: EveInstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly type: "turn.started";
}

export interface EveInstrumentationTurnSettledEvent {
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly type: "turn.cancelled" | "turn.completed";
}

export interface EveInstrumentationTurnFailedEvent {
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly type: "turn.failed";
}

export interface EveInstrumentationModelCallStartedEvent {
  readonly idempotencyKey: string;
  readonly input?: EveInstrumentationModelInput;
  readonly model: {
    readonly modelId: string;
    readonly provider: string;
  };
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "model.call.started";
}

export interface EveInstrumentationModelCallCompletedEvent {
  readonly content?: readonly EveInstrumentationContentPart[];
  readonly finishReason: string;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "model.call.completed";
  readonly usage: EveInstrumentationUsage;
}

export interface EveInstrumentationModelCallFailedEvent {
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "model.call.failed";
}

export interface EveInstrumentationStepAttemptCompletedEvent {
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "step.attempt.completed";
}

export interface EveInstrumentationStepAttemptFailedEvent {
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "step.attempt.failed";
}

export interface EveInstrumentationActionStartedEvent {
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly input?: unknown;
  readonly name: string;
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "action.started";
}

export interface EveInstrumentationActionCompletedEvent {
  readonly acceptedAtMs?: number;
  readonly idempotencyKey: string;
  readonly output:
    | { readonly output?: unknown; readonly type: "result" }
    | { readonly error?: unknown; readonly type: "error" };
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "action.completed";
}

export interface EveInstrumentationActionFailedEvent {
  readonly acceptedAtMs?: number;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly idempotencyKey: string;
  readonly outcome: "abandoned" | "cancelled" | "failed" | "rejected";
  readonly scope: EveInstrumentationAttemptScope;
  readonly type: "action.failed";
}

/** Eve 0.72+ replaces action events with tool.call events. */
export interface EveInstrumentationToolCallStartedEvent {
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly input?: unknown;
  readonly kind?:
    | "load-skill"
    | "remote-agent-call"
    | "subagent-call"
    | "tool-call";
  readonly parentCallId?: string;
  readonly startedAtMs?: number;
  readonly scope: EveInstrumentationAttemptScope;
  readonly toolName: string;
  readonly type: "tool.call.started";
}

export type EveInstrumentationToolCallTerminalEvent =
  | {
      readonly acceptedAtMs?: number;
      readonly completedAtMs?: number;
      readonly idempotencyKey: string;
      readonly outcome?:
        | "completed"
        | "abandoned"
        | "cancelled"
        | "failed"
        | "rejected";
      readonly output:
        | { readonly output?: unknown; readonly type: "result" }
        | { readonly error?: unknown; readonly type: "error" };
      readonly scope: EveInstrumentationAttemptScope;
      readonly type: "tool.call.completed";
    }
  | {
      readonly acceptedAtMs?: number;
      readonly completedAtMs?: number;
      readonly error?: unknown;
      readonly errorCode?: string;
      readonly idempotencyKey: string;
      readonly outcome?: "abandoned" | "cancelled" | "failed" | "rejected";
      readonly scope: EveInstrumentationAttemptScope;
      readonly type: "tool.call.failed";
    };

/** Eve 0.91 uses settled events and identifies attempts by model run. */
export interface EveInstrumentationTurnSettlementEvent {
  readonly type: "turn.settled";
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export type EveInstrumentationModelCallSettledEvent =
  | (Omit<EveInstrumentationModelCallCompletedEvent, "type"> & {
      readonly type: "model.call.settled";
      readonly outcome: "completed";
    })
  | (Omit<EveInstrumentationModelCallFailedEvent, "type"> & {
      readonly type: "model.call.settled";
      readonly outcome: "failed";
    });

export interface EveInstrumentationCallRequestedEvent {
  readonly type: "call.requested";
  readonly capability: {
    readonly kind: "tool" | "agent" | "skill" | "control";
    readonly remote?: true;
  };
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly input?: unknown;
  readonly startedAtMs?: number;
  readonly scope: EveInstrumentationAttemptScope;
  readonly toolName: string;
}

export interface EveInstrumentationCallSettledEvent {
  readonly type: "call.settled";
  readonly outcome:
    | "completed"
    | "failed"
    | "rejected"
    | "interrupted"
    | "abandoned";
  readonly output?: unknown;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly acceptedAtMs?: number;
  readonly completedAtMs?: number;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
}

export interface EveInstrumentationModelRunTerminalEvent {
  readonly type: "model.settled" | "model.retried";
  readonly outcome?:
    | "completed"
    | "failed"
    | "interrupted"
    | "abandoned"
    | "cancelled";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
}

type EveInstrumentationHandler<TEvent> = (
  event: TEvent,
  context: EveInstrumentationHandlerContext,
) => void | PromiseLike<void>;

export interface EveInstrumentationDefinition {
  readonly capture: "content";
  readonly tracePolicy?: (trace: {
    readonly agentName?: string;
    readonly audience: "private" | "public" | "unknown";
    readonly channelType?: string;
  }) =>
    | boolean
    | { readonly emit: false }
    | {
        readonly emit: true;
        readonly recordInputs: boolean;
        readonly recordOutputs: boolean;
      };
  readonly events: {
    readonly "call.requested": EveInstrumentationHandler<EveInstrumentationCallRequestedEvent>;
    readonly "call.settled": EveInstrumentationHandler<EveInstrumentationCallSettledEvent>;
    readonly "model.call.settled": EveInstrumentationHandler<EveInstrumentationModelCallSettledEvent>;
    readonly "model.settled": EveInstrumentationHandler<EveInstrumentationModelRunTerminalEvent>;
    readonly "model.retried": EveInstrumentationHandler<EveInstrumentationModelRunTerminalEvent>;
    readonly "turn.settled": EveInstrumentationHandler<EveInstrumentationTurnSettlementEvent>;

    readonly "tool.call.started": EveInstrumentationHandler<EveInstrumentationToolCallStartedEvent>;
    readonly "tool.call.completed": EveInstrumentationHandler<
      Extract<
        EveInstrumentationToolCallTerminalEvent,
        { type: "tool.call.completed" }
      >
    >;
    readonly "tool.call.failed": EveInstrumentationHandler<
      Extract<
        EveInstrumentationToolCallTerminalEvent,
        { type: "tool.call.failed" }
      >
    >;
    readonly "action.completed": EveInstrumentationHandler<EveInstrumentationActionCompletedEvent>;
    readonly "action.failed": EveInstrumentationHandler<EveInstrumentationActionFailedEvent>;
    readonly "action.started": EveInstrumentationHandler<EveInstrumentationActionStartedEvent>;
    readonly "model.call.completed": EveInstrumentationHandler<EveInstrumentationModelCallCompletedEvent>;
    readonly "model.call.failed": EveInstrumentationHandler<EveInstrumentationModelCallFailedEvent>;
    readonly "model.call.started": EveInstrumentationHandler<EveInstrumentationModelCallStartedEvent>;
    readonly "step.attempt.completed": EveInstrumentationHandler<EveInstrumentationStepAttemptCompletedEvent>;
    readonly "step.attempt.failed": EveInstrumentationHandler<EveInstrumentationStepAttemptFailedEvent>;
    readonly "turn.cancelled": EveInstrumentationHandler<EveInstrumentationTurnSettledEvent>;
    readonly "turn.completed": EveInstrumentationHandler<EveInstrumentationTurnSettledEvent>;
    readonly "turn.failed": EveInstrumentationHandler<EveInstrumentationTurnFailedEvent>;
    readonly "turn.started": EveInstrumentationHandler<EveInstrumentationTurnStartedEvent>;
  };
  readonly flush: () => Promise<void>;
  readonly setup?: (
    context: EveInstrumentationSetupContext,
  ) => void | PromiseLike<void>;
}
