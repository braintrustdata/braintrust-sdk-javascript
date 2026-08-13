import { debugLogger } from "../../debug-logger";
import {
  NOOP_SPAN,
  _internalStartSpanWithInitialMerge,
  flush,
  withCurrent,
} from "../../logger";
import type { Span } from "../../logger";
import { LRUCache } from "../../lru-cache";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  EveContentOptions,
  EveInstrumentationActionCompletedEvent,
  EveInstrumentationActionFailedEvent,
  EveInstrumentationActionKind,
  EveInstrumentationActionStartedEvent,
  EveInstrumentationCapture,
  EveInstrumentationContentPart,
  EveInstrumentationModelCallCompletedEvent,
  EveInstrumentationModelCallFailedEvent,
  EveInstrumentationModelCallStartedEvent,
  EveInstrumentationModelInput,
  EveProviderContext,
  EveProviderDefinition,
  EveProviderSetupContext,
  EveInstrumentationSessionFailedEvent,
  EveInstrumentationSessionSettledEvent,
  EveInstrumentationSessionStartedEvent,
  EveInstrumentationStepAttemptCompletedEvent,
  EveInstrumentationStepAttemptFailedEvent,
  EveInstrumentationStepAttemptMetadataEvent,
  EveInstrumentationStepAttemptStartedEvent,
  EveInstrumentationTurnFailedEvent,
  EveInstrumentationTurnSettledEvent,
  EveInstrumentationTurnStartedEvent,
  EveInstrumentationUsage,
} from "../../vendor-sdk-types/eve-provider";

type EveSpan = Pick<Span, "end" | "export" | "log" | "rootSpanId" | "spanId">;

type SpanState = {
  metadata: Record<string, unknown>;
  span: EveSpan;
};

type StepState = SpanState & {
  input?: unknown;
  metrics: Record<string, number>;
  output?: unknown;
};

type ActionState = SpanState & {
  endedByTurn?: boolean;
  turnKey: string;
};

type EveEntityKind = "action" | "step" | "turn";

const MAX_EVE_CACHE_ENTRIES = 10_000;

/**
 * Braintrust instrumentation provider for eve's lifecycle bus.
 *
 * Consume this from `agent/instrumentation/braintrust.ts` (the provider
 * directory layout) when the eve version supports
 * `experimental.instrumentationProviders`. For older eve, keep using
 * {@link braintrustEveInstrumentation} with the single-file
 * `agent/instrumentation.ts` layout.
 *
 * The provider receives structured lifecycle events directly from eve's
 * instrumentation bus — no stream-event parsing, no `defineState`, and no
 * manual LLM-input capture. eve assigns replay-stable idempotency keys
 * and durable per-operation state through `ctx.state`.
 *
 * Content redaction follows eve's per-destination `ContentOptions` model:
 * `recordInputs` and `recordOutputs` default to `false`, so the provider
 * captures metadata only (structure, identity, usage, timing) unless the
 * caller opts in. When both are `false`, the provider declares `capture:
 * "metadata"` so eve never builds the content projection at all. When
 * either is `true`, the provider declares `capture: "content"` and
 * respects its own redaction policy in each handler.
 *
 * Requires eve >= 0.34.0 with `experimental.instrumentationProviders` on.
 */
export function braintrustEveProvider(options: {
  recordInputs?: boolean;
  recordOutputs?: boolean;
  setup?: (context: EveProviderSetupContext) => void | PromiseLike<void>;
}): EveProviderDefinition {
  const recordInputs = options.recordInputs === true;
  const recordOutputs = options.recordOutputs === true;
  const capture: EveInstrumentationCapture =
    recordInputs || recordOutputs ? "content" : "metadata";
  const bridge = new EveProviderBridge({ recordInputs, recordOutputs });
  return {
    capture,
    events: {
      "session.started": (event, ctx) =>
        bridge.handleSessionStarted(event, ctx),
      "session.completed": (event, ctx) =>
        bridge.handleSessionSettled(event, ctx),
      "session.waiting": (event, ctx) =>
        bridge.handleSessionSettled(event, ctx),
      "session.failed": (event, ctx) => bridge.handleSessionFailed(event, ctx),
      "turn.started": (event, ctx) => bridge.handleTurnStarted(event, ctx),
      "turn.completed": (event, ctx) => bridge.handleTurnSettled(event, ctx),
      "turn.cancelled": (event, ctx) => bridge.handleTurnSettled(event, ctx),
      "turn.failed": (event, ctx) => bridge.handleTurnFailed(event, ctx),
      "step.attempt.started": (event, ctx) =>
        bridge.handleStepAttemptStarted(event, ctx),
      "step.attempt.completed": (event, ctx) =>
        bridge.handleStepAttemptCompleted(event, ctx),
      "step.attempt.failed": (event, ctx) =>
        bridge.handleStepAttemptFailed(event, ctx),
      "step.attempt.metadata": (event, ctx) =>
        bridge.handleStepAttemptMetadata(event, ctx),
      "model.call.started": (event, ctx) =>
        bridge.handleModelCallStarted(event, ctx),
      "model.call.completed": (event, ctx) =>
        bridge.handleModelCallCompleted(event, ctx),
      "model.call.failed": (event, ctx) =>
        bridge.handleModelCallFailed(event, ctx),
      "action.started": (event, ctx) => bridge.handleActionStarted(event, ctx),
      "action.completed": (event, ctx) =>
        bridge.handleActionCompleted(event, ctx),
      "action.failed": (event, ctx) => bridge.handleActionFailed(event, ctx),
    } satisfies EveProviderDefinition["events"],
    flush: async () => {
      await bridge.flush();
    },
    shutdown: async () => {
      await bridge.flush();
    },
    setup: options.setup,
  };
}

class EveProviderBridge {
  private readonly recordInputs: boolean;
  private readonly recordOutputs: boolean;

  constructor(content: EveContentOptions) {
    this.recordInputs = content.recordInputs === true;
    this.recordOutputs = content.recordOutputs === true;
  }

  private turnsByKey = new LRUCache<
    string,
    SpanState & { key: string; sessionId: string; turnId: string }
  >({
    max: MAX_EVE_CACHE_ENTRIES,
  });
  private stepsByKey = new LRUCache<string, StepState>({
    max: MAX_EVE_CACHE_ENTRIES,
  });
  private actionsByKey = new LRUCache<string, ActionState>({
    max: MAX_EVE_CACHE_ENTRIES,
  });
  private sessionMetadata = new Map<string, Record<string, unknown>>();

  // --- Session ---

  handleSessionStarted(
    event: EveInstrumentationSessionStartedEvent,
    _ctx: EveProviderContext,
  ): void {
    const metadata: Record<string, unknown> = {
      "eve.session_id": event.sessionId,
    };
    if (event.agentName) metadata["eve.agent_name"] = event.agentName;
    if (event.channelKind) metadata["eve.channel_kind"] = event.channelKind;

    this.sessionMetadata.set(event.sessionId, metadata);

    for (const [, turn] of this.turnsByKey) {
      if (turn.sessionId !== event.sessionId) continue;
      turn.metadata = { ...turn.metadata, ...metadata };
      turn.span.log({ metadata: turn.metadata });
    }
  }

  handleSessionSettled(
    event: EveInstrumentationSessionSettledEvent,
    _ctx: EveProviderContext,
  ): void {
    if (event.type === "session.waiting") {
      this.sessionMetadata.delete(event.sessionId);
    } else {
      this.finalizeSession(event.sessionId, { endTime: undefined });
    }
    if (event.type === "session.completed") {
      void this.flush();
    }
  }

  handleSessionFailed(
    event: EveInstrumentationSessionFailedEvent,
    ctx: EveProviderContext,
  ): void {
    const error = normalizeError(event.error);
    this.finalizeSession(event.sessionId, { endTime: undefined, error });
    void this.flush();
  }

  // --- Turn ---

  handleTurnStarted(
    event: EveInstrumentationTurnStartedEvent,
    ctx: EveProviderContext,
  ): void {
    const key = event.idempotencyKey;
    if (this.turnsByKey.has(key)) {
      const existing = this.turnsByKey.get(key)!;
      existing.span.log({ metadata: existing.metadata });
      return;
    }

    const sessionId = event.sessionId;
    const sessionMeta = this.sessionMetadata.get(sessionId) ?? {};
    const metadata: Record<string, unknown> = {
      ...sessionMeta,
      "eve.session_id": sessionId,
      "eve.turn_sequence": event.sequence,
    };

    const rootSpanId = deterministicId(
      "eve:root",
      event.rootSessionId,
      event.turnId,
    );
    const parentSpanId = event.parentLineage
      ? deterministicId(
          "eve:subagent",
          event.parentLineage.sessionId,
          event.parentLineage.callId,
        )
      : undefined;

    const spanId = deterministicId("eve:turn", sessionId, event.turnId);
    const rowId = event.idempotencyKey;
    const span = this.startSpan({
      event: { id: rowId, metadata },
      name: "eve.turn",
      parentSpanIds: parentSpanId
        ? { rootSpanId, spanId: parentSpanId }
        : { parentSpanIds: [], rootSpanId },
      spanAttributes: { type: SpanTypeAttribute.TASK },
      spanId,
    });
    span.log({ metadata });

    const turnState = { key, metadata, sessionId, span, turnId: event.turnId };
    this.turnsByKey.set(key, turnState);
    this.storeDurableRef(ctx, "turn", rowId, span, {
      sessionId,
      turnId: event.turnId,
    });
  }

  handleTurnSettled(
    event: EveInstrumentationTurnSettledEvent,
    _ctx: EveProviderContext,
  ): void {
    const turn = this.turnsByKey.get(event.idempotencyKey);
    if (!turn) return;
    this.finalizeTurn(event.idempotencyKey, { endTime: undefined });
  }

  handleTurnFailed(
    event: EveInstrumentationTurnFailedEvent,
    _ctx: EveProviderContext,
  ): void {
    const turn = this.turnsByKey.get(event.idempotencyKey);
    if (!turn) return;
    this.finalizeTurn(event.idempotencyKey, {
      endTime: undefined,
      error: normalizeError(event.error),
    });
  }

  // --- Step attempt ---

  handleStepAttemptStarted(
    event: EveInstrumentationStepAttemptStartedEvent,
    ctx: EveProviderContext,
  ): void {
    const key = event.idempotencyKey;
    const turnKey = turnIdempotencyKey(
      event.scope.sessionId,
      event.scope.turnId,
    );
    const turn = this.turnsByKey.get(turnKey);
    if (!turn) return;

    // Close any existing step for this attempt (retry replaces previous)
    const existing = this.stepsByKey.get(key);
    if (existing) {
      existing.span.log({
        ...(this.recordInputs && existing.input !== undefined
          ? { input: existing.input }
          : {}),
        metadata: existing.metadata,
        metrics: existing.metrics,
        ...(this.recordOutputs && existing.output !== undefined
          ? { output: existing.output }
          : {}),
      });
      existing.span.end();
    }

    const modelMeta = modelMetadataFromOperation(event.operation);
    const metadata: Record<string, unknown> = {
      ...turn.metadata,
      ...modelMeta,
      "eve.step_index": event.scope.stepIndex,
      "eve.attempt_index": event.scope.attemptIndex,
    };

    const spanId = deterministicId("eve:step", event.scope.attemptId);
    const span = this.startChildSpan(turn.span, {
      event: { id: event.idempotencyKey, metadata },
      name: "eve.step",
      spanAttributes: { type: SpanTypeAttribute.LLM },
      spanId,
    });
    span.log({ metadata });

    this.stepsByKey.set(key, {
      metadata,
      metrics: {},
      span,
    });
  }

  handleStepAttemptMetadata(
    event: EveInstrumentationStepAttemptMetadataEvent,
    _ctx: EveProviderContext,
  ): void {
    const step = this.stepsByKey.get(event.idempotencyKey);
    if (!step) return;
    const gateway = event.providerMetadata?.gateway;
    if (isObject(gateway) && typeof gateway["generationId"] === "string") {
      step.metadata["eve.gateway_generation_id"] = gateway["generationId"];
      step.span.log({ metadata: step.metadata });
    }
  }

  handleStepAttemptCompleted(
    event: EveInstrumentationStepAttemptCompletedEvent,
    _ctx: EveProviderContext,
  ): void {
    this.finalizeStep(event.idempotencyKey, { endTime: undefined });
  }

  handleStepAttemptFailed(
    event: EveInstrumentationStepAttemptFailedEvent,
    _ctx: EveProviderContext,
  ): void {
    this.finalizeStep(event.idempotencyKey, {
      endTime: undefined,
      error: normalizeError(event.error),
    });
  }

  // --- Model call (logs to the step span, does not create a separate span) ---

  handleModelCallStarted(
    event: EveInstrumentationModelCallStartedEvent,
    _ctx: EveProviderContext,
  ): void {
    if (!this.recordInputs) return;
    const step = this.stepsByKey.get(event.idempotencyKey);
    if (!step || !event.input) return;
    const captured = captureModelInput(event.input);
    if (captured) {
      step.input = captured;
      step.span.log({ input: captured });
    }
  }

  handleModelCallCompleted(
    event: EveInstrumentationModelCallCompletedEvent,
    _ctx: EveProviderContext,
  ): void {
    const step = this.stepsByKey.get(event.idempotencyKey);
    if (!step) return;

    if (this.recordOutputs) {
      const output = contentPartsToOutput(event.content, event.finishReason);
      if (output !== undefined) {
        step.output = output;
      }
    }
    const metrics = usageToMetrics(event.usage);
    if (Object.keys(metrics).length > 0) {
      step.metrics = { ...step.metrics, ...metrics };
    }
    step.span.log({
      ...(this.recordInputs && step.input !== undefined
        ? { input: step.input }
        : {}),
      metadata: step.metadata,
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      ...(step.output !== undefined ? { output: step.output } : {}),
    });
  }

  handleModelCallFailed(
    event: EveInstrumentationModelCallFailedEvent,
    _ctx: EveProviderContext,
  ): void {
    const step = this.stepsByKey.get(event.idempotencyKey);
    if (!step) return;
    step.span.log({
      error: normalizeError(event.error),
      metadata: step.metadata,
    });
  }

  // --- Action (tool, subagent, etc.) ---

  handleActionStarted(
    event: EveInstrumentationActionStartedEvent,
    ctx: EveProviderContext,
  ): void {
    const key = event.idempotencyKey;
    if (this.actionsByKey.has(key)) return;

    const turnKey = turnIdempotencyKey(
      event.scope.sessionId,
      event.scope.turnId,
    );
    const turn = this.turnsByKey.get(turnKey);
    if (!turn) return;

    const name = actionSpanName(event.kind, event.name);
    const metadata = actionMetadata(turn.metadata, event.kind);
    const spanId = deterministicId(
      "eve:action",
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );

    const span = this.startChildSpan(turn.span, {
      event: {
        id: event.idempotencyKey,
        ...(this.recordInputs && event.input !== undefined
          ? { input: event.input }
          : {}),
        metadata,
      },
      name,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
    });
    span.log({
      ...(this.recordInputs && event.input !== undefined
        ? { input: event.input }
        : {}),
      metadata,
    });

    this.actionsByKey.set(key, {
      metadata,
      span,
      turnKey,
    });
  }

  handleActionCompleted(
    event: EveInstrumentationActionCompletedEvent,
    _ctx: EveProviderContext,
  ): void {
    const action = this.actionsByKey.get(event.idempotencyKey);
    if (!action) return;
    const output = this.recordOutputs
      ? actionOutputToValue(event.output)
      : undefined;
    const metrics = event.usage ? usageToMetrics(event.usage) : {};
    action.span.log({
      metadata: action.metadata,
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      ...(output !== undefined ? { output } : {}),
    });
    const endTime = event.acceptedAtMs ? event.acceptedAtMs / 1000 : undefined;
    action.span.end(endTime === undefined ? undefined : { endTime });
    this.actionsByKey.delete(event.idempotencyKey);
  }

  handleActionFailed(
    event: EveInstrumentationActionFailedEvent,
    _ctx: EveProviderContext,
  ): void {
    const action = this.actionsByKey.get(event.idempotencyKey);
    if (!action) return;
    action.span.log({
      error: normalizeError(event.error),
      metadata: action.metadata,
    });
    const endTime = event.acceptedAtMs ? event.acceptedAtMs / 1000 : undefined;
    action.span.end(endTime === undefined ? undefined : { endTime });
    this.actionsByKey.delete(event.idempotencyKey);
  }

  // --- Flush / shutdown ---

  async flush(): Promise<boolean> {
    try {
      await flush();
      return true;
    } catch (error) {
      debugLogger.warn("Error in Eve provider flush:", error);
      return false;
    }
  }

  // --- Internals ---

  private startSpan(
    args: Parameters<typeof _internalStartSpanWithInitialMerge>[0],
  ): EveSpan {
    const rowId = args?.event?.id;
    if (typeof rowId === "string") {
      // Try to find a durable reference for resumption
    }
    const span = withCurrent(NOOP_SPAN, () =>
      _internalStartSpanWithInitialMerge(
        withSpanInstrumentationName(
          { ...args, startTime: args?.startTime ?? getCurrentUnixTimestamp() },
          INSTRUMENTATION_NAMES.EVE,
        ),
      ),
    );
    return span;
  }

  private startChildSpan(
    parent: EveSpan,
    args: Parameters<typeof _internalStartSpanWithInitialMerge>[0],
  ): EveSpan {
    return this.startSpan({
      ...args,
      parentSpanIds: {
        rootSpanId: parent.rootSpanId,
        spanId: parent.spanId,
      },
    });
  }

  private storeDurableRef(
    ctx: EveProviderContext,
    kind: EveEntityKind,
    rowId: string,
    span: EveSpan,
    owner: { sessionId: string; turnId?: string },
  ): void {
    try {
      void span.export().then((exported) => {
        ctx.state.set({
          exported,
          kind,
          rootSpanId: span.rootSpanId,
          rowId,
          sessionId: owner.sessionId,
          spanId: span.spanId,
          ...(owner.turnId ? { turnId: owner.turnId } : {}),
        } as unknown as Parameters<EveProviderContext["state"]["set"]>[0]);
      });
    } catch (error) {
      debugLogger.warn("Error storing durable Eve span ref:", error);
    }
  }

  private finalizeStep(
    key: string,
    args: { endTime: number | undefined; error?: Error },
  ): void {
    const step = this.stepsByKey.get(key);
    if (!step) return;
    if (args.error) {
      step.span.log({ error: args.error });
    } else {
      step.span.log({
        ...(this.recordInputs && step.input !== undefined
          ? { input: step.input }
          : {}),
        metadata: step.metadata,
        metrics: step.metrics,
        ...(this.recordOutputs && step.output !== undefined
          ? { output: step.output }
          : {}),
      });
    }
    step.span.end(
      args.endTime === undefined ? undefined : { endTime: args.endTime },
    );
    this.stepsByKey.delete(key);
  }

  private finalizeTurn(
    key: string,
    args: { endTime: number | undefined; error?: Error },
  ): void {
    const turn = this.turnsByKey.get(key);
    if (!turn) return;

    // Close any open steps
    for (const [stepKey, step] of this.stepsByKey) {
      if (!stepKey.startsWith(`step:${turn.sessionId}:${turn.turnId}:`))
        continue;
      step.span.log({
        ...(this.recordInputs && step.input !== undefined
          ? { input: step.input }
          : {}),
        metadata: step.metadata,
        metrics: step.metrics,
        ...(this.recordOutputs && step.output !== undefined
          ? { output: step.output }
          : {}),
      });
      step.span.end(
        args.endTime === undefined ? undefined : { endTime: args.endTime },
      );
      this.stepsByKey.delete(stepKey);
    }

    // Close any open actions for this turn
    for (const [, action] of this.actionsByKey) {
      if (action.turnKey !== key || action.endedByTurn) continue;
      action.span.log({ metadata: action.metadata });
      action.span.end(
        args.endTime === undefined ? undefined : { endTime: args.endTime },
      );
      action.endedByTurn = true;
    }

    if (args.error) {
      turn.span.log({ error: args.error });
    } else {
      turn.span.log({ metadata: turn.metadata });
    }
    turn.span.end(
      args.endTime === undefined ? undefined : { endTime: args.endTime },
    );
    this.turnsByKey.delete(key);
  }

  private finalizeSession(
    sessionId: string,
    args: { endTime: number | undefined; error?: Error },
  ): void {
    for (const [, turn] of this.turnsByKey) {
      if (turn.sessionId !== sessionId) continue;
      this.finalizeTurn(turn.key, args);
    }
    // Clean up any remaining actions
    for (const [key, action] of this.actionsByKey) {
      if (!key.includes(`${sessionId}:`)) continue;
      if (!action.endedByTurn) {
        action.span.log({ metadata: action.metadata });
        action.span.end(
          args.endTime === undefined ? undefined : { endTime: args.endTime },
        );
      }
      this.actionsByKey.delete(key);
    }
    this.sessionMetadata.delete(sessionId);
  }
}

// --- Helpers ---

function turnIdempotencyKey(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

function deterministicId(...parts: string[]): string {
  // Synchronous SHA-256 is not available in all environments; use a
  // simple but stable hash for span IDs. This only needs to be
  // deterministic, not cryptographically secure.
  const text = parts.map((p) => `${p.length}:${p}`).join("\0");
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193);
  }
  const hex =
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(4, 8)}-${hex.slice(0, 4)}-${hex.slice(0, 12)}`;
}

function modelMetadataFromOperation(operation: {
  readonly modelId: string;
  readonly provider: string;
}): Record<string, unknown> {
  const modelId = operation.modelId;
  if (!modelId || modelId.trim().startsWith("dynamic:")) return {};
  return modelMetadataFromModelId(modelId);
}

function modelMetadataFromModelId(modelId: string): Record<string, unknown> {
  const normalized = modelId.trim();
  if (!normalized) return {};
  const slashIndex = normalized.indexOf("/");
  if (slashIndex > 0 && slashIndex < normalized.length - 1) {
    return {
      model: normalized.slice(slashIndex + 1),
      provider: normalized.slice(0, slashIndex),
    };
  }
  return { model: normalized };
}

function actionSpanName(
  kind: EveInstrumentationActionKind,
  name: string,
): string {
  switch (kind) {
    case "subagent-call":
      return name || "agent";
    default:
      return name;
  }
}

function actionMetadata(
  turnMetadata: Record<string, unknown>,
  kind: EveInstrumentationActionKind,
): Record<string, unknown> {
  const { model: _model, provider: _provider, ...rest } = turnMetadata;
  void _model;
  void _provider;
  return {
    ...rest,
    "eve.action_kind": kind,
  };
}

function usageToMetrics(
  usage: EveInstrumentationUsage,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  if (typeof usage.inputTokens === "number" && usage.inputTokens >= 0) {
    metrics.prompt_tokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number" && usage.outputTokens >= 0) {
    metrics.completion_tokens = usage.outputTokens;
  }
  if (
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  ) {
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  }
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens;
  if (typeof cacheRead === "number" && cacheRead >= 0) {
    metrics.prompt_cached_tokens = cacheRead;
  }
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  if (typeof cacheWrite === "number" && cacheWrite >= 0) {
    metrics.prompt_cache_creation_tokens = cacheWrite;
  }
  return metrics;
}

function captureModelInput(
  input: EveInstrumentationModelInput,
): unknown | undefined {
  try {
    const value: unknown[] = [];
    if (input.instructions !== undefined) {
      value.push(input.instructions);
    }
    value.push(...input.messages);
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function contentPartsToOutput(
  content: readonly EveInstrumentationContentPart[] | undefined,
  finishReason: string,
): unknown | undefined {
  if (!content || content.length === 0) return undefined;
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: unknown[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        textParts.push(part.text);
        break;
      case "reasoning":
        reasoningParts.push(part.text);
        break;
      case "tool-call":
        toolCalls.push({
          function: {
            arguments: JSON.stringify(part.input),
            name: part.toolName,
          },
          id: part.callId,
          type: "function",
        });
        break;
      // tool-result and tool-error are not part of model output
    }
  }
  const message: Record<string, unknown> = {
    content: textParts.length > 0 ? textParts.join("") : null,
    role: "assistant",
  };
  if (reasoningParts.length > 0) {
    message["reasoning"] = reasoningParts.map((content) => ({ content }));
  }
  if (toolCalls.length > 0) {
    message["tool_calls"] = toolCalls;
  }
  return [
    {
      finish_reason: finishReason,
      index: 0,
      message,
    },
  ];
}

function actionOutputToValue(
  output:
    | { readonly type: "result"; readonly output?: unknown }
    | { readonly type: "error"; readonly error?: unknown },
): unknown | undefined {
  if (output.type === "result") return output.output;
  if (output.type === "error") return output.error;
  return undefined;
}

function normalizeError(error: unknown): Error | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (isObject(error)) {
    const message =
      typeof error["message"] === "string" ? error["message"] : "Eve error";
    const code = typeof error["code"] === "string" ? error["code"] : undefined;
    const result = new Error(code ? `${code}: ${message}` : message);
    if (error["details"] !== undefined) {
      result.cause = error["details"];
    }
    return result;
  }
  return new Error(String(error));
}

export type { EveProviderDefinition, EveContentOptions };
