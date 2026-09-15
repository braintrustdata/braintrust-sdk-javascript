import { debugLogger } from "../../debug-logger";
import {
  NOOP_SPAN,
  _internalStartSpanWithInitialMerge,
  flush,
  updateSpan,
  withCurrent,
} from "../../logger";
import type { Span } from "../../logger";
import { LRUCache } from "../../lru-cache";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import type {
  EveInstrumentationAttemptScope,
  EveProviderActionStartedEvent,
  EveProviderActionTerminalEvent,
  EveProviderContext,
  EveProviderDefinition,
  EveProviderModelCallStartedEvent,
  EveProviderModelCallTerminalEvent,
  EveProviderStepAttemptTerminalEvent,
  EveProviderTurnStartedEvent,
  EveProviderTurnTerminalEvent,
  EveProviderUsage,
} from "../../vendor-sdk-types/eve";
import { capturedModelInput, generateEveIds } from "./eve-plugin";

const MAX_EVE_PROVIDER_CACHE_ENTRIES = 10_000;

type EveProviderOptions = {
  metadata?: Record<string, unknown>;
  setup?: EveProviderDefinition["setup"];
};

type StoredSpan =
  | { exported: string; rootSpanId?: string; skip?: never }
  | { skip: true };

type TurnContext = {
  rootSpanId: string;
  spanId: string;
};

type ActiveSpan = {
  span: Span;
  turnKey: string;
};

type EveProviderEvent =
  | EveProviderActionStartedEvent
  | EveProviderActionTerminalEvent
  | EveProviderModelCallStartedEvent
  | EveProviderModelCallTerminalEvent
  | EveProviderStepAttemptTerminalEvent
  | EveProviderTurnStartedEvent
  | EveProviderTurnTerminalEvent;

type EveProviderEventForType<TType extends EveProviderEvent["type"]> =
  EveProviderEvent extends infer TEvent
    ? TEvent extends { type: infer TEventType }
      ? TType extends TEventType
        ? TEvent & { type: TType }
        : never
      : never
    : never;

/**
 * Braintrust-native instrumentation for Eve's provider lifecycle (eve@0.34+).
 *
 * Used by `braintrustEveInstrumentation` for Eve's instrumentation-provider
 * lifecycle. Kept separate from the legacy event bridge so the public helper
 * can support both APIs without exposing a second integration name.
 */
export function createEveInstrumentationProvider(
  options: EveProviderOptions = {},
): EveProviderDefinition {
  const bridge = new EveProviderBridge(options.metadata);
  return {
    // Eve versions before tracePolicy use capture to decide whether provider
    // events include content. Newer versions prefer tracePolicy when both are
    // present, so keep the deprecated field for backwards compatibility.
    capture: "content",
    tracePolicy: () => ({
      emit: true,
      recordInputs: true,
      recordOutputs: true,
    }),
    events: {
      "action.completed": providerHandler(
        "action.completed",
        bridge.handleActionTerminal.bind(bridge),
      ),
      "action.failed": providerHandler(
        "action.failed",
        bridge.handleActionTerminal.bind(bridge),
      ),
      "action.started": providerHandler(
        "action.started",
        bridge.handleActionStarted.bind(bridge),
      ),
      "model.call.completed": providerHandler(
        "model.call.completed",
        bridge.handleModelTerminal.bind(bridge),
      ),
      "model.call.failed": providerHandler(
        "model.call.failed",
        bridge.handleModelTerminal.bind(bridge),
      ),
      "model.call.started": providerHandler(
        "model.call.started",
        bridge.handleModelStarted.bind(bridge),
      ),
      "step.attempt.completed": providerHandler(
        "step.attempt.completed",
        (event) => bridge.handleStepAttemptTerminal(event),
      ),
      "step.attempt.failed": providerHandler("step.attempt.failed", (event) =>
        bridge.handleStepAttemptTerminal(event),
      ),
      "turn.cancelled": providerHandler(
        "turn.cancelled",
        bridge.handleTurnTerminal.bind(bridge),
      ),
      "turn.completed": providerHandler(
        "turn.completed",
        bridge.handleTurnTerminal.bind(bridge),
      ),
      "turn.failed": providerHandler(
        "turn.failed",
        bridge.handleTurnTerminal.bind(bridge),
      ),
      "turn.started": providerHandler(
        "turn.started",
        bridge.handleTurnStarted.bind(bridge),
      ),
    },
    flush,
    setup: options.setup,
  };
}

class EveProviderBridge {
  private readonly activeActions = new Map<string, ActiveSpan>();
  private readonly activeModels = new Map<string, ActiveSpan>();
  private readonly modelsByAttempt = new Map<string, Set<string>>();
  private readonly settledOperations = new LRUCache<string, true>({
    max: MAX_EVE_PROVIDER_CACHE_ENTRIES,
  });
  private readonly turns = new LRUCache<string, TurnContext>({
    max: MAX_EVE_PROVIDER_CACHE_ENTRIES,
  });

  constructor(private readonly metadata?: Record<string, unknown>) {}

  async handleTurnStarted(
    event: EveProviderTurnStartedEvent,
    context: EveProviderContext,
  ): Promise<void> {
    await this.contain("turn start", async () => {
      if (this.settledOperations.has(event.idempotencyKey)) {
        context.state.set({ skip: true });
        return;
      }
      const { rowId, spanId } = await generateEveIds(
        "turn",
        event.idempotencyKey,
      );
      const key = turnKey(event.sessionId, event.turnId);
      const stored = storedSpan(context);
      // Eve persists provider state by operation. A replay in a replacement
      // process can rebuild the local lineage cache without reopening the span.
      if (stored && "exported" in stored && stored.rootSpanId) {
        this.turns.set(key, { rootSpanId: stored.rootSpanId, spanId });
        return;
      }
      let rootSpanId = spanId;
      let parentSpanId: string | undefined;
      if (event.parentLineage) {
        const parentTurnKey = turnKey(
          event.parentLineage.sessionId,
          event.parentLineage.turnId,
        );
        const parentTurn = this.turns.get(parentTurnKey);
        rootSpanId =
          parentTurn?.rootSpanId ??
          // Eve propagates the root session through every nested subagent. Use
          // it instead of the immediate parent session when no ancestor ran
          // in-process.
          (
            await generateEveIds(
              "turn",
              turnIdempotencyKey(
                event.rootSessionId,
                event.parentLineage.turnId,
              ),
            )
          ).spanId;
        parentSpanId = (
          await generateEveIds(
            "subagent",
            actionIdempotencyKey(
              event.parentLineage.sessionId,
              event.parentLineage.turnId,
              event.parentLineage.callId,
            ),
          )
        ).spanId;
      }

      const metadata = this.spanMetadata(event.sessionId);
      const span = await this.startSpan(
        context,
        {
          event: { id: rowId, metadata },
          name: "eve.turn",
          parentSpanIds: parentSpanId
            ? { rootSpanId, spanId: parentSpanId }
            : { parentSpanIds: [], rootSpanId },
          spanAttributes: { type: SpanTypeAttribute.TASK },
          spanId,
        },
        rootSpanId,
      );
      span?.log({ metadata });
      this.turns.set(key, {
        rootSpanId,
        spanId,
      });
    });
  }

  async handleTurnTerminal(
    event: EveProviderTurnTerminalEvent,
    context: EveProviderContext,
  ): Promise<void> {
    await this.contain("turn terminal", async () => {
      if (this.settledOperations.has(event.idempotencyKey)) {
        context.state.set(undefined);
        return;
      }
      const error = event.type === "turn.failed" ? event.error : undefined;
      this.drainActionsForTurn(event.sessionId, event.turnId, error);
      const stored = storedSpan(context);
      if (stored && "exported" in stored) {
        updateSpan({
          exported: stored.exported,
          ...(error !== undefined ? { error } : {}),
          metrics: { end: Date.now() / 1000 },
        });
      }
      this.settledOperations.set(event.idempotencyKey, true);
      context.state.set(undefined);
      this.turns.delete(turnKey(event.sessionId, event.turnId));
    });
  }

  async handleModelStarted(
    event: EveProviderModelCallStartedEvent,
    context: EveProviderContext,
  ): Promise<void> {
    await this.contain("model start", async () => {
      if (this.settledOperations.has(event.idempotencyKey)) {
        context.state.set({ skip: true });
        return;
      }
      const parent = await this.parentForScope(event.scope);
      const { rowId, spanId } = await generateEveIds(
        "step",
        event.idempotencyKey,
      );
      const input = event.input ? capturedModelInput(event.input) : undefined;
      const metadata = {
        ...this.spanMetadata(event.scope.sessionId),
        model: event.model.modelId,
        provider: event.model.provider,
      };
      const span = await this.startSpan(context, {
        event: {
          id: rowId,
          ...(input !== undefined ? { input } : {}),
          metadata,
        },
        name: "eve.step",
        parentSpanIds: parent,
        spanAttributes: { type: SpanTypeAttribute.LLM },
        spanId,
      });
      if (!span) return;
      span.log({ ...(input !== undefined ? { input } : {}), metadata });
      this.activeModels.set(event.idempotencyKey, {
        span,
        turnKey: turnKey(event.scope.sessionId, event.scope.turnId),
      });
      const keys = this.modelsByAttempt.get(event.scope.attemptId) ?? new Set();
      keys.add(event.idempotencyKey);
      this.modelsByAttempt.set(event.scope.attemptId, keys);
    });
  }

  async handleModelTerminal(
    event: EveProviderModelCallTerminalEvent,
    context: EveProviderContext,
  ): Promise<void> {
    await this.contain("model terminal", async () => {
      if (this.settledOperations.has(event.idempotencyKey)) {
        context.state.set(undefined);
        return;
      }
      const active = this.activeModels.get(event.idempotencyKey);
      if (active) {
        const span = active.span;
        if (event.type === "model.call.failed") {
          if (event.error !== undefined) span.log({ error: event.error });
        } else {
          span.log({
            metrics: usageMetrics(event.usage),
            output: modelOutput(event),
          });
        }
        span.end();
      } else {
        const stored = storedSpan(context);
        if (stored && "exported" in stored) {
          updateSpan({
            exported: stored.exported,
            ...(event.type === "model.call.failed"
              ? event.error !== undefined
                ? { error: event.error }
                : {}
              : { output: modelOutput(event) }),
            metrics: {
              ...(event.type === "model.call.completed"
                ? usageMetrics(event.usage)
                : {}),
              end: Date.now() / 1000,
            },
          });
        }
      }
      this.settledOperations.set(event.idempotencyKey, true);
      this.forgetModel(event.scope.attemptId, event.idempotencyKey);
      context.state.set(undefined);
    });
  }

  async handleActionStarted(
    event: EveProviderActionStartedEvent,
    context: EveProviderContext,
  ): Promise<void> {
    await this.contain("action start", async () => {
      if (
        event.kind === "load-skill" ||
        this.settledOperations.has(event.idempotencyKey)
      ) {
        context.state.set({ skip: true });
        return;
      }
      const parent = await this.parentForScope(event.scope);
      const { rowId, spanId } = await generateEveIds(
        event.kind === "subagent-call" ? "subagent" : "tool",
        event.idempotencyKey,
      );
      const metadata = {
        ...this.spanMetadata(event.scope.sessionId),
        "eve.action_kind": event.kind,
      };
      const span = await this.startSpan(context, {
        event: {
          id: rowId,
          ...(event.input !== undefined ? { input: event.input } : {}),
          metadata,
        },
        name: event.name,
        parentSpanIds: parent,
        spanAttributes: { type: SpanTypeAttribute.TOOL },
        spanId,
      });
      if (!span) return;
      span.log({
        ...(event.input !== undefined ? { input: event.input } : {}),
        metadata,
      });
      this.activeActions.set(event.idempotencyKey, {
        span,
        turnKey: turnKey(event.scope.sessionId, event.scope.turnId),
      });
    });
  }

  async handleActionTerminal(
    event: EveProviderActionTerminalEvent,
    context: EveProviderContext,
  ): Promise<void> {
    await this.contain("action terminal", async () => {
      if (this.settledOperations.has(event.idempotencyKey)) {
        context.state.set(undefined);
        return;
      }
      const stored = storedSpan(context);
      if (stored?.skip) {
        context.state.set(undefined);
        return;
      }
      const active = this.activeActions.get(event.idempotencyKey);
      const end = finiteTimestamp(event.acceptedAtMs) ?? Date.now();
      if (active) {
        const span = active.span;
        if (event.type === "action.failed") {
          span.log({
            error:
              event.error ??
              new Error(event.errorCode ?? `Eve action ${event.outcome}`),
          });
        } else if (event.output.type === "error") {
          span.log({
            error:
              event.output.error ?? new Error("Eve action returned an error"),
          });
        } else {
          span.log({ output: event.output.output });
        }
        span.end({ endTime: end / 1000 });
      } else {
        const stored = storedSpan(context);
        if (stored && "exported" in stored) {
          updateSpan({
            exported: stored.exported,
            ...(event.type === "action.failed"
              ? {
                  error:
                    event.error ??
                    new Error(event.errorCode ?? `Eve action ${event.outcome}`),
                }
              : event.output.type === "error"
                ? {
                    error:
                      event.output.error ??
                      new Error("Eve action returned an error"),
                  }
                : { output: event.output.output }),
            metrics: { end: end / 1000 },
          });
        }
      }
      this.settledOperations.set(event.idempotencyKey, true);
      this.activeActions.delete(event.idempotencyKey);
      context.state.set(undefined);
    });
  }

  handleStepAttemptTerminal(event: EveProviderStepAttemptTerminalEvent): void {
    void this.contain("step attempt terminal", () => {
      const keys = this.modelsByAttempt.get(event.scope.attemptId);
      if (!keys) return;
      for (const key of keys) {
        const active = this.activeModels.get(key);
        if (!active) continue;
        if (event.type === "step.attempt.failed" && event.error !== undefined) {
          active.span.log({ error: event.error });
        }
        active.span.end();
        this.activeModels.delete(key);
      }
      this.modelsByAttempt.delete(event.scope.attemptId);
    });
  }

  private async parentForScope(scope: EveInstrumentationAttemptScope) {
    const key = turnKey(scope.sessionId, scope.turnId);
    const known = this.turns.get(key);
    if (known) {
      return { rootSpanId: known.rootSpanId, spanId: known.spanId };
    }
    const [{ spanId }, { spanId: rootSpanId }] = await Promise.all([
      generateEveIds("turn", turnIdempotencyKey(scope.sessionId, scope.turnId)),
      generateEveIds(
        "turn",
        turnIdempotencyKey(
          scope.rootSessionId ?? scope.sessionId,
          scope.turnId,
        ),
      ),
    ]);
    return { rootSpanId, spanId };
  }

  private async startSpan(
    context: EveProviderContext,
    args: Parameters<typeof _internalStartSpanWithInitialMerge>[0],
    rootSpanId?: string,
  ): Promise<Span | undefined> {
    const span = withCurrent(NOOP_SPAN, () =>
      _internalStartSpanWithInitialMerge(
        withSpanInstrumentationName(args ?? {}, INSTRUMENTATION_NAMES.EVE),
      ),
    );
    try {
      context.state.set({
        exported: await span.export(),
        ...(rootSpanId ? { rootSpanId } : {}),
      });
    } catch (error) {
      debugLogger.warn("Error exporting Eve provider span:", error);
    }
    return span;
  }

  private drainActionsForTurn(
    sessionId: string,
    turnId: string,
    error: unknown,
  ): void {
    const key = turnKey(sessionId, turnId);
    for (const [idempotencyKey, active] of this.activeActions) {
      if (active.turnKey !== key) continue;
      if (error !== undefined) active.span.log({ error });
      active.span.end();
      this.activeActions.delete(idempotencyKey);
    }
  }

  private forgetModel(attemptId: string, idempotencyKey: string): void {
    this.activeModels.delete(idempotencyKey);
    const keys = this.modelsByAttempt.get(attemptId);
    keys?.delete(idempotencyKey);
    if (keys?.size === 0) this.modelsByAttempt.delete(attemptId);
  }

  private spanMetadata(sessionId: string): Record<string, unknown> {
    return {
      ...(this.metadata ?? {}),
      "eve.session_id": sessionId,
    };
  }

  private async contain(
    operation: string,
    fn: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      debugLogger.warn(`Error in Eve provider ${operation}:`, error);
    }
  }
}

function storedSpan(context: EveProviderContext): StoredSpan | undefined {
  const value = context.state.get();
  if (!isObject(value)) return undefined;
  if (value["skip"] === true) return { skip: true };
  return typeof value["exported"] === "string"
    ? {
        exported: value["exported"],
        ...(typeof value["rootSpanId"] === "string" &&
        value["rootSpanId"].length > 0
          ? { rootSpanId: value["rootSpanId"] }
          : {}),
      }
    : undefined;
}

function modelOutput(
  event: Extract<
    EveProviderModelCallTerminalEvent,
    { type: "model.call.completed" }
  >,
): unknown {
  const content = event.content ?? [];
  let text = "";
  const reasoning: { content: string }[] = [];
  const toolCalls: {
    function: { arguments: string; name: string };
    id: string;
    type: "function";
  }[] = [];
  for (const part of content) {
    if (!isObject(part)) {
      continue;
    }
    if (part["type"] === "text" && typeof part["text"] === "string") {
      text += part["text"];
    } else if (
      part["type"] === "reasoning" &&
      typeof part["text"] === "string" &&
      part["text"].trim().length > 0
    ) {
      reasoning.push({ content: part["text"] });
    } else if (
      part["type"] === "tool-call" &&
      typeof part["toolName"] === "string" &&
      typeof part["callId"] === "string"
    ) {
      toolCalls.push({
        function: {
          arguments: safeJsonStringify(part["input"]),
          name: part["toolName"],
        },
        id: part["callId"],
        type: "function",
      });
    }
  }
  return [
    {
      finish_reason: normalizeFinishReason(event.finishReason),
      index: 0,
      message: {
        content: text || null,
        ...(reasoning.length > 0 ? { reasoning } : {}),
        role: "assistant",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    },
  ];
}

function usageMetrics(usage: EveProviderUsage): Record<string, number> {
  const promptTokens = nonNegativeNumber(usage?.inputTokens);
  const completionTokens = nonNegativeNumber(usage?.outputTokens);
  const cachedTokens = nonNegativeNumber(
    usage?.inputTokenDetails?.cacheReadTokens,
  );
  const cacheCreationTokens = nonNegativeNumber(
    usage?.inputTokenDetails?.cacheWriteTokens,
  );
  return {
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(completionTokens !== undefined
      ? { completion_tokens: completionTokens }
      : {}),
    ...(promptTokens !== undefined && completionTokens !== undefined
      ? { tokens: promptTokens + completionTokens }
      : {}),
    ...(cachedTokens !== undefined
      ? { prompt_cached_tokens: cachedTokens }
      : {}),
    ...(cacheCreationTokens !== undefined
      ? { prompt_cache_creation_tokens: cacheCreationTokens }
      : {}),
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeFinishReason(value: string): string {
  if (value === "content-filter") return "content_filter";
  if (value === "tool-calls") return "tool_calls";
  return value;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function turnIdempotencyKey(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

function actionIdempotencyKey(
  sessionId: string,
  turnId: string,
  callId: string,
): string {
  return `action:${sessionId}:${turnId}:${callId}`;
}

function providerHandler<TType extends EveProviderEvent["type"]>(
  type: TType,
  handler: (
    event: EveProviderEventForType<TType>,
    context: EveProviderContext,
  ) => void | Promise<void>,
): (event: unknown, context: unknown) => Promise<void> {
  return async (event, context) => {
    try {
      if (!isEveProviderEvent(event, type) || !isEveProviderContext(context)) {
        debugLogger.warn(`Ignoring malformed Eve provider ${type} event`);
        return;
      }
      await handler(event, context);
    } catch (error) {
      debugLogger.warn(`Error in Eve provider ${type}:`, error);
    }
  };
}

function isEveProviderEvent<TType extends EveProviderEvent["type"]>(
  event: unknown,
  type: TType,
): event is EveProviderEventForType<TType> {
  if (
    !isObject(event) ||
    event["type"] !== type ||
    typeof event["idempotencyKey"] !== "string" ||
    event["idempotencyKey"].length === 0
  ) {
    return false;
  }
  if (type === "turn.started") {
    const parentLineage = event["parentLineage"];
    return (
      typeof event["rootSessionId"] === "string" &&
      typeof event["sessionId"] === "string" &&
      typeof event["turnId"] === "string" &&
      typeof event["sequence"] === "number" &&
      Number.isFinite(event["sequence"]) &&
      (parentLineage === undefined || isEveProviderParentLineage(parentLineage))
    );
  }
  if (
    type === "turn.cancelled" ||
    type === "turn.completed" ||
    type === "turn.failed"
  ) {
    return (
      typeof event["sessionId"] === "string" &&
      typeof event["turnId"] === "string"
    );
  }
  if (!isEveProviderScope(event["scope"])) {
    return false;
  }
  if (type === "model.call.started") {
    const model = event["model"];
    return (
      isObject(model) &&
      typeof model["modelId"] === "string" &&
      typeof model["provider"] === "string"
    );
  }
  if (type === "model.call.completed") {
    return (
      typeof event["finishReason"] === "string" &&
      isObject(event["usage"]) &&
      (event["content"] === undefined || Array.isArray(event["content"]))
    );
  }
  if (type === "model.call.failed") {
    return true;
  }
  if (type === "action.started") {
    return (
      typeof event["callId"] === "string" &&
      typeof event["name"] === "string" &&
      (event["kind"] === "load-skill" ||
        event["kind"] === "remote-agent-call" ||
        event["kind"] === "subagent-call" ||
        event["kind"] === "tool-call")
    );
  }
  if (type === "action.completed") {
    const output = event["output"];
    return (
      event["outcome"] === "completed" &&
      isObject(output) &&
      (output["type"] === "result" || output["type"] === "error")
    );
  }
  if (type === "action.failed") {
    return (
      event["outcome"] === "abandoned" ||
      event["outcome"] === "cancelled" ||
      event["outcome"] === "failed" ||
      event["outcome"] === "rejected"
    );
  }
  return type === "step.attempt.completed" || type === "step.attempt.failed";
}

function isEveProviderContext(value: unknown): value is EveProviderContext {
  if (!isObject(value) || !isObject(value["state"])) {
    return false;
  }
  return (
    typeof value["state"]["get"] === "function" &&
    typeof value["state"]["set"] === "function"
  );
}

function isEveProviderScope(
  value: unknown,
): value is EveInstrumentationAttemptScope {
  return (
    isObject(value) &&
    typeof value["attemptId"] === "string" &&
    typeof value["attemptIndex"] === "number" &&
    Number.isFinite(value["attemptIndex"]) &&
    typeof value["sessionId"] === "string" &&
    typeof value["stepIndex"] === "number" &&
    Number.isFinite(value["stepIndex"]) &&
    typeof value["turnId"] === "string" &&
    (value["rootSessionId"] === undefined ||
      typeof value["rootSessionId"] === "string")
  );
}

function isEveProviderParentLineage(
  value: unknown,
): value is EveProviderTurnStartedEvent["parentLineage"] {
  return (
    isObject(value) &&
    typeof value["callId"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["turnId"] === "string"
  );
}
