/**
 * Vendored types for eve's instrumentation provider contract.
 *
 * These mirror the public types exported from `eve/instrumentation` when the
 * `experimental.instrumentationProviders` flag is on. Keep this surface
 * intentionally narrow — only the fields the Braintrust provider reads,
 * correlates, or logs.
 */

export type EveInstrumentationCapture = "content" | "metadata";

/**
 * What this provider records of the conversation itself.
 *
 * Mirrors eve's `ContentOptions`: declining is per provider, not per process.
 * Content is only projected by eve when at least one provider asks, and a
 * provider that declined never receives it. Defaults to `false` for both,
 * matching eve's convention.
 */
export interface EveContentOptions {
  /** Record model prompts and tool call inputs. Defaults to `false`. */
  readonly recordInputs?: boolean;
  /** Record model responses and tool call outputs. Defaults to `false`. */
  readonly recordOutputs?: boolean;
}

export type EveInstrumentationEnvironment =
  | "development"
  | "preview"
  | "production";

export interface EveProviderSetupContext {
  readonly agentName: string;
  readonly environment?: EveInstrumentationEnvironment;
  readonly frameworkVersion?: string;
}

export interface EveProviderState {
  get(): unknown;
  set(value: unknown): void;
}

export interface EveProviderContext {
  readonly state: EveProviderState;
}

export interface EveInstrumentationAttemptScope {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly functionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface EveInstrumentationOperationRef {
  readonly modelId: string;
  readonly operationId: string;
  readonly provider: string;
}

export interface EveInstrumentationModelRef {
  readonly modelId: string;
  readonly provider: string;
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
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly input: unknown;
      readonly toolName: string;
    }
  | {
      readonly type: "tool-result";
      readonly callId: string;
      readonly input: unknown;
      readonly output: unknown;
      readonly toolName: string;
    }
  | {
      readonly type: "tool-error";
      readonly callId: string;
      readonly error: unknown;
      readonly input: unknown;
      readonly toolName: string;
    };

export type EveInstrumentationActionKind =
  | "load-skill"
  | "remote-agent-call"
  | "subagent-call"
  | "tool-call";

export type EveInstrumentationActionOutput =
  | { readonly type: "result"; readonly output?: unknown }
  | { readonly type: "error"; readonly error?: unknown };

export type EveInstrumentationActionOutcome =
  | "abandoned"
  | "cancelled"
  | "completed"
  | "failed"
  | "rejected";

export interface EveInstrumentationParentLineage {
  readonly callId: string;
  readonly sessionId: string;
  readonly subagentName?: string;
  readonly turnId: string;
}

export interface EveInstrumentationTraceContext {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}

// --- Events ---

export interface EveInstrumentationSessionStartedEvent {
  readonly type: "session.started";
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly idempotencyKey: string;
  readonly parentTraceContext?: EveInstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

export interface EveInstrumentationSessionSettledEvent {
  readonly type: "session.completed" | "session.waiting";
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface EveInstrumentationSessionFailedEvent {
  readonly type: "session.failed";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface EveInstrumentationTurnStartedEvent {
  readonly type: "turn.started";
  readonly idempotencyKey: string;
  readonly parentLineage?: EveInstrumentationParentLineage;
  readonly parentTraceContext?: EveInstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface EveInstrumentationTurnSettledEvent {
  readonly type: "turn.cancelled" | "turn.completed";
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface EveInstrumentationTurnFailedEvent {
  readonly type: "turn.failed";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface EveInstrumentationStepAttemptStartedEvent {
  readonly type: "step.attempt.started";
  readonly idempotencyKey: string;
  readonly operation: EveInstrumentationOperationRef;
  readonly scope: EveInstrumentationAttemptScope;
}

export interface EveInstrumentationStepAttemptCompletedEvent {
  readonly type: "step.attempt.completed";
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
}

export interface EveInstrumentationStepAttemptFailedEvent {
  readonly type: "step.attempt.failed";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
}

export interface EveInstrumentationStepAttemptMetadataEvent {
  readonly type: "step.attempt.metadata";
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

export interface EveInstrumentationModelCallStartedEvent {
  readonly type: "model.call.started";
  readonly idempotencyKey: string;
  readonly input?: EveInstrumentationModelInput;
  readonly model: EveInstrumentationModelRef;
  readonly scope: EveInstrumentationAttemptScope;
}

export interface EveInstrumentationModelCallCompletedEvent {
  readonly type: "model.call.completed";
  readonly content?: readonly EveInstrumentationContentPart[];
  readonly finishReason: string;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
  readonly usage: EveInstrumentationUsage;
}

export interface EveInstrumentationModelCallFailedEvent {
  readonly type: "model.call.failed";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: EveInstrumentationAttemptScope;
}

export interface EveInstrumentationActionStartedEvent {
  readonly type: "action.started";
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly input?: unknown;
  readonly kind: EveInstrumentationActionKind;
  readonly name: string;
  readonly scope: EveInstrumentationAttemptScope;
}

export interface EveInstrumentationActionCompletedEvent {
  readonly type: "action.completed";
  readonly acceptedAtMs?: number;
  readonly idempotencyKey: string;
  readonly outcome: "completed";
  readonly output: EveInstrumentationActionOutput;
  readonly scope: EveInstrumentationAttemptScope;
  readonly usage?: EveInstrumentationUsage;
}

export interface EveInstrumentationActionFailedEvent {
  readonly type: "action.failed";
  readonly acceptedAtMs?: number;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly idempotencyKey: string;
  readonly outcome: Exclude<EveInstrumentationActionOutcome, "completed">;
  readonly scope: EveInstrumentationAttemptScope;
}

type EveInstrumentationEvent =
  | EveInstrumentationSessionStartedEvent
  | EveInstrumentationSessionSettledEvent
  | EveInstrumentationSessionFailedEvent
  | EveInstrumentationTurnStartedEvent
  | EveInstrumentationTurnSettledEvent
  | EveInstrumentationTurnFailedEvent
  | EveInstrumentationStepAttemptStartedEvent
  | EveInstrumentationStepAttemptCompletedEvent
  | EveInstrumentationStepAttemptFailedEvent
  | EveInstrumentationStepAttemptMetadataEvent
  | EveInstrumentationModelCallStartedEvent
  | EveInstrumentationModelCallCompletedEvent
  | EveInstrumentationModelCallFailedEvent
  | EveInstrumentationActionStartedEvent
  | EveInstrumentationActionCompletedEvent
  | EveInstrumentationActionFailedEvent;

export type EveProviderEvents = {
  readonly [TType in EveInstrumentationEvent["type"]]?: (
    event: Extract<EveInstrumentationEvent, { readonly type: TType }>,
    ctx: EveProviderContext,
  ) => void | PromiseLike<void>;
};

export interface EveProviderDefinition {
  readonly capture?: EveInstrumentationCapture;
  readonly events?: EveProviderEvents;
  readonly setup?: (
    context: EveProviderSetupContext,
  ) => void | PromiseLike<void>;
  readonly flush?: () => void | PromiseLike<void>;
  readonly shutdown?: () => void | PromiseLike<void>;
}
