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
  | EveJsonValue[]
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

export interface EveInstrumentationAttemptScope {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

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

type EveInstrumentationHandler<TEvent> = (
  event: TEvent,
  context: EveInstrumentationHandlerContext,
) => void | PromiseLike<void>;

export interface EveInstrumentationDefinition {
  readonly capture: "content";
  readonly events: {
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
