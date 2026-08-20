import { debugLogger } from "../../debug-logger";
import {
  Attachment,
  NOOP_SPAN,
  _internalStartSpanWithInitialMerge,
  currentLogger,
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
import { getCurrentUnixTimestamp } from "../../util";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  processInputAttachments,
} from "../../wrappers/attachment-utils";
import type {
  EveInstrumentationActionCompletedEvent,
  EveInstrumentationActionFailedEvent,
  EveInstrumentationActionStartedEvent,
  EveInstrumentationContentPart,
  EveInstrumentationDefinition,
  EveInstrumentationHandlerContext,
  EveInstrumentationModelCallCompletedEvent,
  EveInstrumentationModelCallFailedEvent,
  EveInstrumentationModelCallStartedEvent,
  EveInstrumentationModelInput,
  EveInstrumentationStepAttemptCompletedEvent,
  EveInstrumentationStepAttemptFailedEvent,
  EveInstrumentationTurnFailedEvent,
  EveInstrumentationTurnSettledEvent,
  EveInstrumentationTurnStartedEvent,
  EveInstrumentationUsage,
} from "../../vendor-sdk-types/eve";

type EveSpan = Pick<Span, "end" | "log" | "rootSpanId" | "spanId">;

type EveSpanReference = {
  readonly exported: string;
  readonly rootSpanId: string;
  readonly spanId: string;
  readonly turnMetricContributions?: Record<string, Record<string, number>>;
};

type TurnState = {
  key: string;
  metadata: Record<string, unknown>;
  rootSpanId: string;
  rowId: string;
  span: EveSpan;
  spanId: string;
};

type EveInstrumentationEvent =
  | EveInstrumentationActionCompletedEvent
  | EveInstrumentationActionFailedEvent
  | EveInstrumentationActionStartedEvent
  | EveInstrumentationModelCallCompletedEvent
  | EveInstrumentationModelCallFailedEvent
  | EveInstrumentationModelCallStartedEvent
  | EveInstrumentationStepAttemptCompletedEvent
  | EveInstrumentationStepAttemptFailedEvent
  | EveInstrumentationTurnFailedEvent
  | EveInstrumentationTurnSettledEvent
  | EveInstrumentationTurnStartedEvent;

const MAX_EVE_CACHE_ENTRIES = 10_000;
const eveRootSpanIdsByTurnKey = new LRUCache<string, string>({
  max: MAX_EVE_CACHE_ENTRIES,
});

/**
 * Creates an Eve instrumentation provider.
 *
 * Eve 0.34.0 introduced the provider event API used here. Older Eve hook and
 * single-file instrumentation layouts are intentionally unsupported.
 */
export function braintrustEveInstrumentation(
  options: {
    metadata?: Record<string, unknown>;
    setup?: EveInstrumentationDefinition["setup"];
  } = {},
): EveInstrumentationDefinition {
  const bridge = new EveBridge(options.metadata);
  return {
    capture: "content",
    events: {
      "action.completed": (event, context) => bridge.handle(event, context),
      "action.failed": (event, context) => bridge.handle(event, context),
      "action.started": (event, context) => bridge.handle(event, context),
      "model.call.completed": (event, context) => bridge.handle(event, context),
      "model.call.failed": (event, context) => bridge.handle(event, context),
      "model.call.started": (event, context) => bridge.handle(event, context),
      "step.attempt.completed": (event, context) =>
        bridge.handle(event, context),
      "step.attempt.failed": (event, context) => bridge.handle(event, context),
      "turn.cancelled": (event, context) => bridge.handle(event, context),
      "turn.completed": (event, context) => bridge.handle(event, context),
      "turn.failed": (event, context) => bridge.handle(event, context),
      "turn.started": (event, context) => bridge.handle(event, context),
    },
    flush: () => flush(),
    setup: options.setup,
  };
}

class ResumedEveSpan implements EveSpan {
  private endTime: number | undefined;

  constructor(private readonly reference: EveSpanReference) {}

  get rootSpanId(): string {
    return this.reference.rootSpanId;
  }

  get spanId(): string {
    return this.reference.spanId;
  }

  log(event: Parameters<Span["log"]>[0]): void {
    updateSpan({
      exported: this.reference.exported,
      ...event,
    });
  }

  end(args?: Parameters<Span["end"]>[0]): number {
    if (this.endTime === undefined) {
      this.endTime = args?.endTime ?? getCurrentUnixTimestamp();
      this.log({ metrics: { end: this.endTime } });
    }
    return this.endTime;
  }
}

class EveBridge {
  private turnsByKey = new LRUCache<string, TurnState>({
    max: MAX_EVE_CACHE_ENTRIES,
  });
  private turnsStartingByKey = new Map<string, Promise<TurnState>>();
  private openModelsByAttempt = new Map<string, Map<string, EveSpan>>();
  private turnMetricContributionsByKey = new Map<
    string,
    Record<string, Record<string, number>>
  >();

  constructor(private readonly configuredMetadata?: Record<string, unknown>) {}

  async handle(
    event: EveInstrumentationEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    try {
      switch (event.type) {
        case "turn.started":
          await this.getOrStartTurn(event, context);
          return;
        case "model.call.started":
          await this.handleModelCallStarted(event, context);
          return;
        case "model.call.completed":
          await this.handleModelCallCompleted(event, context);
          return;
        case "model.call.failed":
          await this.handleModelCallFailed(event, context);
          return;
        case "step.attempt.completed":
        case "step.attempt.failed":
          this.handleStepAttemptTerminal(event);
          return;
        case "action.started":
          await this.handleActionStarted(event, context);
          return;
        case "action.completed":
          await this.handleActionCompleted(event, context);
          return;
        case "action.failed":
          await this.handleActionFailed(event, context);
          return;
        case "turn.cancelled":
        case "turn.completed":
          await this.handleTurnSettled(event, context);
          return;
        case "turn.failed":
          await this.handleTurnFailed(event, context);
          return;
      }
    } catch (error) {
      debugLogger.warn("Error in Eve instrumentation provider:", error);
    }
  }

  private async handleModelCallStarted(
    event: EveInstrumentationModelCallStartedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const turn = await this.turnForScope(event.scope, context);
    const metadata = {
      ...this.metadata(event.scope.sessionId),
      ...modelMetadata(event.model.modelId, event.model.provider),
    };
    const input = capturedModelInput(event.input);
    const ids = await generateEveIds("step", event.idempotencyKey);
    const span = await this.startEveSpan(context, {
      event: {
        id: ids.rowId,
        ...(input === undefined ? {} : { input }),
        metadata,
      },
      name: "eve.step",
      parentSpanIds: {
        rootSpanId: turn.rootSpanId,
        spanId: turn.spanId,
      },
      spanAttributes: { type: SpanTypeAttribute.LLM },
      spanId: ids.spanId,
    });
    const reference = readSpanReference(context.state.get());
    if (reference !== undefined) {
      context.state.set({
        ...reference,
        turnMetricContributions:
          this.turnMetricContributionsByKey.get(turn.key) ?? {},
      });
    }
    const openModels =
      this.openModelsByAttempt.get(event.scope.attemptId) ?? new Map();
    openModels.set(event.idempotencyKey, span);
    this.openModelsByAttempt.set(event.scope.attemptId, openModels);

    if (input !== undefined) {
      const initialInput = initialTurnInput(input);
      if (initialInput !== undefined) {
        this.updateTurn(turn, { input: initialInput });
      }
    }
  }

  private async handleModelCallCompleted(
    event: EveInstrumentationModelCallCompletedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const turn = await this.turnForScope(event.scope, context);
    this.restoreTurnMetricContributions(turn.key, context.state.get());
    const span = await this.resumeModelSpan(event, context, turn);
    const metrics = usageMetrics(event.usage);
    const output = modelOutput(event.finishReason, event.content);
    span.log({ metrics, output });
    span.end();
    this.closeOpenModel(event.scope.attemptId, event.idempotencyKey);
    this.updateTurnMetrics(turn, event.idempotencyKey, metrics);

    const finalOutput = finalText(event.content);
    if (
      finalOutput !== undefined &&
      normalizedFinishReason(event.finishReason) !== "tool_calls"
    ) {
      this.updateTurn(turn, { output: finalOutput });
    }
  }

  private async handleModelCallFailed(
    event: EveInstrumentationModelCallFailedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const turn = await this.turnForScope(event.scope, context);
    const span = await this.resumeModelSpan(event, context, turn);
    span.log({ error: toError(event.error, "Eve model call failed") });
    span.end();
    this.closeOpenModel(event.scope.attemptId, event.idempotencyKey);
  }

  private handleStepAttemptTerminal(
    event:
      | EveInstrumentationStepAttemptCompletedEvent
      | EveInstrumentationStepAttemptFailedEvent,
  ): void {
    const openModels = this.openModelsByAttempt.get(event.scope.attemptId);
    if (openModels === undefined) {
      return;
    }
    for (const span of openModels.values()) {
      if (event.type === "step.attempt.failed") {
        span.log({
          error: toError(event.error, "Eve step attempt failed"),
        });
      }
      span.end();
    }
    this.openModelsByAttempt.delete(event.scope.attemptId);
  }

  private async handleActionStarted(
    event: EveInstrumentationActionStartedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const turn = await this.turnForScope(event.scope, context);
    const metadata = turn.metadata;
    const input = processInputAttachments(event.input);
    const ids = await generateEveIds(
      "action",
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    await this.startEveSpan(context, {
      event: {
        id: ids.rowId,
        ...(input === undefined ? {} : { input }),
        metadata,
      },
      name: event.name,
      parentSpanIds: {
        rootSpanId: turn.rootSpanId,
        spanId: turn.spanId,
      },
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId: ids.spanId,
    });
  }

  private async handleActionCompleted(
    event: EveInstrumentationActionCompletedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const span = await this.resumeActionSpan(event, context);
    if (event.output.type === "error") {
      span.log({
        error: toError(event.output.error, "Eve action failed"),
      });
    } else if (event.output.output !== undefined) {
      span.log({ output: processInputAttachments(event.output.output) });
    }
    span.end(actionEndArgs(event.acceptedAtMs));
  }

  private async handleActionFailed(
    event: EveInstrumentationActionFailedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const span = await this.resumeActionSpan(event, context);
    span.log({
      error: toError(
        event.error,
        event.errorCode === undefined
          ? "Eve action " + event.outcome
          : event.errorCode + ": Eve action " + event.outcome,
      ),
    });
    span.end(actionEndArgs(event.acceptedAtMs));
  }

  private async handleTurnSettled(
    event: EveInstrumentationTurnSettledEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const turn = await this.resumeTurn(event, context);
    turn.span.end();
    this.turnsByKey.delete(turn.key);
    this.turnMetricContributionsByKey.delete(turn.key);
  }

  private async handleTurnFailed(
    event: EveInstrumentationTurnFailedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<void> {
    const turn = await this.resumeTurn(event, context);
    turn.span.log({
      error: toError(event.error, "Eve turn failed"),
    });
    turn.span.end();
    this.turnsByKey.delete(turn.key);
    this.turnMetricContributionsByKey.delete(turn.key);
  }

  private async startTurnSpan(
    event: EveInstrumentationTurnStartedEvent,
    context: EveInstrumentationHandlerContext,
    metadata: Record<string, unknown>,
  ): Promise<EveSpan> {
    const ids = await generateEveIds("turn", event.sessionId, event.turnId);
    const parentSpanId =
      event.parentLineage === undefined
        ? undefined
        : await deterministicEveId(
            "eve:action",
            event.parentLineage.sessionId,
            event.parentLineage.turnId,
            event.parentLineage.callId,
          );
    const parentTurn =
      event.parentLineage === undefined
        ? undefined
        : this.turnsByKey.get(
            turnKey(event.parentLineage.sessionId, event.parentLineage.turnId),
          );
    const parentRootSpanId =
      event.parentLineage === undefined
        ? undefined
        : eveRootSpanIdsByTurnKey.get(
            turnKey(event.parentLineage.sessionId, event.parentLineage.turnId),
          );
    const rootSpanId =
      event.parentLineage === undefined
        ? await deterministicEveId("eve:root", event.sessionId, event.turnId)
        : (parentTurn?.rootSpanId ??
          parentRootSpanId ??
          (typeof event.parentTraceContext?.traceId === "string" &&
          event.parentTraceContext.traceId.length > 0
            ? event.parentTraceContext.traceId
            : await deterministicEveId(
                "eve:root",
                event.parentLineage.sessionId,
                event.parentLineage.turnId,
              )));
    return await this.startEveSpan(context, {
      event: { id: ids.rowId, metadata },
      name: "eve.turn",
      parentSpanIds:
        parentSpanId === undefined
          ? { parentSpanIds: [], rootSpanId }
          : { rootSpanId, spanId: parentSpanId },
      spanAttributes: { type: SpanTypeAttribute.TASK },
      spanId: ids.spanId,
    });
  }

  private async startEveSpan(
    context: EveInstrumentationHandlerContext,
    args: Parameters<typeof _internalStartSpanWithInitialMerge>[0],
  ): Promise<EveSpan> {
    const reference = readSpanReference(context.state.get());
    if (reference !== undefined) {
      return new ResumedEveSpan(reference);
    }

    const startTime = args?.startTime ?? getCurrentUnixTimestamp();
    const span = withCurrent(NOOP_SPAN, () =>
      _internalStartSpanWithInitialMerge(
        withSpanInstrumentationName(
          { ...args, startTime },
          INSTRUMENTATION_NAMES.EVE,
        ),
      ),
    );

    try {
      const reference: EveSpanReference = {
        exported: await span.export(),
        rootSpanId: span.rootSpanId,
        spanId: span.spanId,
      };
      context.state.set(reference);
    } catch (error) {
      debugLogger.warn("Error exporting Eve span for resumption:", error);
    }
    return span;
  }

  private async getOrStartTurn(
    event: EveInstrumentationTurnStartedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<TurnState> {
    const key = turnKey(event.sessionId, event.turnId);
    const existing = this.turnsByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const starting = this.turnsStartingByKey.get(key);
    if (starting !== undefined) {
      return await starting;
    }

    const metadata = this.metadata(event.sessionId);
    const start = (async () => {
      const ids = await generateEveIds("turn", event.sessionId, event.turnId);
      const span = await this.startTurnSpan(event, context, metadata);
      const turn = {
        key,
        metadata,
        rootSpanId: span.rootSpanId,
        rowId: ids.rowId,
        span,
        spanId: span.spanId,
      };
      this.turnsByKey.set(key, turn);
      eveRootSpanIdsByTurnKey.set(key, turn.rootSpanId);
      return turn;
    })();
    this.turnsStartingByKey.set(key, start);
    try {
      return await start;
    } finally {
      if (this.turnsStartingByKey.get(key) === start) {
        this.turnsStartingByKey.delete(key);
      }
    }
  }

  private async resumeTurn(
    event:
      | EveInstrumentationTurnSettledEvent
      | EveInstrumentationTurnFailedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<TurnState> {
    const key = turnKey(event.sessionId, event.turnId);
    const existing = this.turnsByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const starting = this.turnsStartingByKey.get(key);
    if (starting !== undefined) {
      return await starting;
    }

    const metadata = this.metadata(event.sessionId);
    const span = await this.startTurnSpan(
      {
        idempotencyKey: event.idempotencyKey,
        rootSessionId: event.sessionId,
        sequence: 0,
        sessionId: event.sessionId,
        turnId: event.turnId,
        type: "turn.started",
      },
      context,
      metadata,
    );
    const ids = await generateEveIds("turn", event.sessionId, event.turnId);
    return {
      key,
      metadata,
      rootSpanId: span.rootSpanId,
      rowId: ids.rowId,
      span,
      spanId: span.spanId,
    };
  }

  private async turnForScope(
    scope: EveInstrumentationModelCallStartedEvent["scope"],
    context: EveInstrumentationHandlerContext,
  ): Promise<TurnState> {
    const key = turnKey(scope.sessionId, scope.turnId);
    const existing = this.turnsByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const starting = this.turnsStartingByKey.get(key);
    if (starting !== undefined) {
      return await starting;
    }

    const ids = await generateEveIds("turn", scope.sessionId, scope.turnId);
    const persistedRootSpanId = readSpanReference(
      context.state.get(),
    )?.rootSpanId;
    const rememberedRootSpanId = eveRootSpanIdsByTurnKey.get(key);
    return {
      key,
      metadata: this.metadata(scope.sessionId),
      rootSpanId:
        persistedRootSpanId ??
        rememberedRootSpanId ??
        (await deterministicEveId(
          "eve:root",
          scope.rootSessionId ?? scope.sessionId,
          scope.turnId,
        )),
      rowId: ids.rowId,
      span: NOOP_SPAN,
      spanId: ids.spanId,
    };
  }

  private updateTurn(
    turn: TurnState,
    event: { input?: unknown; output?: unknown },
  ): void {
    currentLogger<true>()?.updateSpan({
      id: turn.rowId,
      root_span_id: turn.rootSpanId,
      span_id: turn.spanId,
      ...event,
    });
  }

  private closeOpenModel(attemptId: string, idempotencyKey: string): void {
    const openModels = this.openModelsByAttempt.get(attemptId);
    if (openModels === undefined) {
      return;
    }
    openModels.delete(idempotencyKey);
    if (openModels.size === 0) {
      this.openModelsByAttempt.delete(attemptId);
    }
  }

  private restoreTurnMetricContributions(
    turnKey: string,
    state: unknown,
  ): void {
    const persisted = readSpanReference(state)?.turnMetricContributions;
    if (
      persisted === undefined ||
      this.turnMetricContributionsByKey.has(turnKey)
    ) {
      return;
    }
    this.turnMetricContributionsByKey.set(turnKey, { ...persisted });
  }

  private updateTurnMetrics(
    turn: TurnState,
    idempotencyKey: string,
    metrics: Record<string, number>,
  ): void {
    const contributions = {
      ...(this.turnMetricContributionsByKey.get(turn.key) ?? {}),
      [idempotencyKey]: metrics,
    };
    this.turnMetricContributionsByKey.set(turn.key, contributions);
    const totals: Record<string, number> = {};
    for (const contribution of Object.values(contributions)) {
      for (const [name, value] of Object.entries(contribution)) {
        totals[name] = (totals[name] ?? 0) + value;
      }
    }
    if (Object.keys(totals).length === 0) {
      return;
    }
    currentLogger<true>()?.updateSpan({
      id: turn.rowId,
      metrics: totals,
      root_span_id: turn.rootSpanId,
      span_id: turn.spanId,
    });
  }

  private async resumeModelSpan(
    event:
      | EveInstrumentationModelCallCompletedEvent
      | EveInstrumentationModelCallFailedEvent,
    context: EveInstrumentationHandlerContext,
    turn: TurnState,
  ): Promise<EveSpan> {
    const ids = await generateEveIds("step", event.idempotencyKey);
    return await this.startEveSpan(context, {
      event: {
        id: ids.rowId,
        metadata: this.metadata(event.scope.sessionId),
      },
      name: "eve.step",
      parentSpanIds: {
        rootSpanId: turn.rootSpanId,
        spanId: turn.spanId,
      },
      spanAttributes: { type: SpanTypeAttribute.LLM },
      spanId: ids.spanId,
    });
  }

  private async resumeActionSpan(
    event:
      | EveInstrumentationActionCompletedEvent
      | EveInstrumentationActionFailedEvent,
    context: EveInstrumentationHandlerContext,
  ): Promise<EveSpan> {
    const turn = await this.turnForScope(event.scope, context);
    const separator = event.idempotencyKey.lastIndexOf(":");
    const callId =
      separator < 0
        ? event.idempotencyKey
        : event.idempotencyKey.slice(separator + 1);
    const ids = await generateEveIds(
      "action",
      event.scope.sessionId,
      event.scope.turnId,
      callId,
    );
    return await this.startEveSpan(context, {
      event: { id: ids.rowId, metadata: turn.metadata },
      name: "eve.action",
      parentSpanIds: {
        rootSpanId: turn.rootSpanId,
        spanId: turn.spanId,
      },
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId: ids.spanId,
    });
  }

  private metadata(sessionId: string): Record<string, unknown> {
    return {
      ...(this.configuredMetadata ?? {}),
      "eve.session_id": sessionId,
    };
  }
}

function readSpanReference(value: unknown): EveSpanReference | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const exported = value["exported"];
  const rootSpanId = value["rootSpanId"];
  const spanId = value["spanId"];
  if (
    typeof exported !== "string" ||
    typeof rootSpanId !== "string" ||
    typeof spanId !== "string"
  ) {
    return undefined;
  }
  return {
    exported,
    rootSpanId,
    spanId,
    ...(isObject(value["turnMetricContributions"])
      ? {
          turnMetricContributions: numericMetricContributions(
            value["turnMetricContributions"],
          ),
        }
      : {}),
  };
}

function capturedModelInput(
  input: EveInstrumentationModelInput | undefined,
): unknown[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value: unknown[] = [];
  if (typeof input.instructions === "string") {
    value.push({ content: input.instructions, role: "system" });
  } else if (Array.isArray(input.instructions)) {
    for (const instruction of input.instructions) {
      const projected = projectedModelMessage(instruction);
      if (projected?.role === "system") {
        value.push(projected);
      }
    }
  } else if (isObject(input.instructions)) {
    const instruction = projectedModelMessage(input.instructions);
    if (instruction?.role === "system") {
      value.push(instruction);
    }
  }
  for (const message of input.messages) {
    const projected = projectedModelMessage(message);
    if (projected !== undefined) {
      value.push(projected);
    }
  }
  return value;
}

function projectedModelMessage(
  value: unknown,
): { content: unknown; role: string } | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const role = value["role"];
  if (
    role !== "system" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  ) {
    return undefined;
  }
  const content = value["content"];
  if (typeof content === "string") {
    return { content, role };
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const projected: unknown[] = [];
  for (const part of content) {
    if (!isObject(part) || typeof part["type"] !== "string") {
      continue;
    }
    switch (part["type"]) {
      case "text":
      case "reasoning":
        if (typeof part["text"] === "string") {
          projected.push({ text: part["text"], type: part["type"] });
        }
        break;
      case "image": {
        if (part["image"] === undefined) {
          break;
        }
        const mediaType =
          typeof part["mediaType"] === "string"
            ? part["mediaType"]
            : "image/png";
        projected.push({
          image: mediaAttachment(part["image"], mediaType, undefined),
          ...(typeof part["mediaType"] === "string" ? { mediaType } : {}),
          type: "image",
        });
        break;
      }
      case "file": {
        const mediaType =
          typeof part["mediaType"] === "string"
            ? part["mediaType"]
            : "application/octet-stream";
        const data =
          part["data"] === undefined
            ? undefined
            : mediaAttachment(
                part["data"],
                mediaType,
                typeof part["filename"] === "string"
                  ? part["filename"]
                  : undefined,
              );
        projected.push({
          ...(data === undefined ? {} : { data }),
          ...(typeof part["filename"] === "string"
            ? { filename: part["filename"] }
            : {}),
          mediaType,
          type: "file",
        });
        break;
      }
      case "tool-call":
        if (
          typeof part["toolCallId"] === "string" &&
          typeof part["toolName"] === "string"
        ) {
          projected.push({
            input: part["input"],
            toolCallId: part["toolCallId"],
            toolName: part["toolName"],
            type: "tool-call",
          });
        }
        break;
      case "tool-result":
        if (
          typeof part["toolCallId"] === "string" &&
          typeof part["toolName"] === "string"
        ) {
          projected.push({
            output: projectedToolOutput(part["output"]),
            toolCallId: part["toolCallId"],
            toolName: part["toolName"],
            type: "tool-result",
          });
        }
        break;
      case "tool-approval-response":
        if (
          typeof part["approvalId"] === "string" &&
          typeof part["approved"] === "boolean"
        ) {
          projected.push({
            approvalId: part["approvalId"],
            approved: part["approved"],
            ...(typeof part["reason"] === "string"
              ? { reason: part["reason"] }
              : {}),
            type: "tool-approval-response",
          });
        }
        break;
      default:
        break;
    }
  }
  return { content: projected, role };
}

function projectedToolOutput(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }
  if (typeof value["type"] !== "string") {
    return undefined;
  }
  switch (value["type"]) {
    case "text":
    case "json":
    case "error-text":
    case "error-json":
      return { type: value["type"], value: value["value"] };
    case "execution-denied":
      return {
        ...(typeof value["reason"] === "string"
          ? { reason: value["reason"] }
          : {}),
        type: "execution-denied",
      };
    case "content": {
      if (!Array.isArray(value["value"])) {
        return { type: "content", value: [] };
      }
      const content: unknown[] = [];
      for (const part of value["value"]) {
        if (!isObject(part) || typeof part["type"] !== "string") {
          continue;
        }
        if (part["type"] === "text" && typeof part["text"] === "string") {
          content.push({ text: part["text"], type: "text" });
        } else if (
          (part["type"] === "file-data" || part["type"] === "image-data") &&
          part["data"] !== undefined &&
          typeof part["mediaType"] === "string"
        ) {
          const data = mediaAttachment(
            part["data"],
            part["mediaType"],
            typeof part["filename"] === "string" ? part["filename"] : undefined,
          );
          content.push({
            ...(data === undefined ? {} : { data }),
            ...(typeof part["filename"] === "string"
              ? { filename: part["filename"] }
              : {}),
            mediaType: part["mediaType"],
            type: part["type"],
          });
        } else if (
          (part["type"] === "file-url" || part["type"] === "image-url") &&
          typeof part["url"] === "string"
        ) {
          content.push({ type: part["type"], url: part["url"] });
        }
      }
      return {
        type: "content",
        value: content,
      };
    }
    default:
      return undefined;
  }
}

function mediaAttachment(
  data: unknown,
  contentType: string,
  filename: string | undefined,
): unknown {
  const blob = convertDataToBlob(data, contentType);
  if (blob === null) {
    return data;
  }
  return new Attachment({
    contentType,
    data: blob,
    filename:
      filename ?? `attachment.${getExtensionFromMediaType(contentType)}`,
  });
}

function initialTurnInput(input: readonly unknown[]): unknown[] | undefined {
  for (let index = input.length - 1; index >= 0; index--) {
    const message = input[index];
    if (isObject(message) && message["role"] === "user") {
      return [message];
    }
  }
  return undefined;
}

function modelOutput(
  finishReason: string,
  content: readonly EveInstrumentationContentPart[] | undefined,
): unknown {
  const parts = content ?? [];
  const text = parts
    .filter(
      (
        part,
      ): part is Extract<EveInstrumentationContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
  const reasoning = parts
    .filter(
      (
        part,
      ): part is Extract<
        EveInstrumentationContentPart,
        { type: "reasoning" }
      > => part.type === "reasoning",
    )
    .map((part) => ({ content: part.text }));
  const toolCalls = parts.flatMap((part) => {
    if (part.type !== "tool-call") {
      return [];
    }
    return [
      {
        function: {
          arguments: jsonString(part.input),
          name: part.toolName,
        },
        id: part.callId,
        type: "function",
      },
    ];
  });
  return [
    {
      finish_reason: normalizedFinishReason(finishReason),
      index: 0,
      message: {
        content: text.length === 0 ? null : text,
        ...(reasoning.length === 0 ? {} : { reasoning }),
        role: "assistant",
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      },
    },
  ];
}

function finalText(
  content: readonly EveInstrumentationContentPart[] | undefined,
): string | undefined {
  const text = (content ?? [])
    .filter(
      (
        part,
      ): part is Extract<EveInstrumentationContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
  return text.length === 0 ? undefined : text;
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

function normalizedFinishReason(finishReason: string): string {
  if (finishReason === "content-filter") {
    return "content_filter";
  }
  if (finishReason === "tool-calls") {
    return "tool_calls";
  }
  return finishReason;
}

function usageMetrics(usage: EveInstrumentationUsage): Record<string, number> {
  const inputTokens = validMetric(usage.inputTokens);
  const outputTokens = validMetric(usage.outputTokens);
  const cacheReadTokens = validMetric(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens = validMetric(
    usage.inputTokenDetails?.cacheWriteTokens,
  );
  return {
    ...(inputTokens === undefined ? {} : { prompt_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { completion_tokens: outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { tokens: inputTokens + outputTokens }),
    ...(cacheReadTokens === undefined
      ? {}
      : { prompt_cached_tokens: cacheReadTokens }),
    ...(cacheWriteTokens === undefined
      ? {}
      : { prompt_cache_creation_tokens: cacheWriteTokens }),
  };
}

function validMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function numericMetrics(
  value: Record<string, unknown>,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const name of [
    "completion_tokens",
    "prompt_cache_creation_tokens",
    "prompt_cached_tokens",
    "prompt_tokens",
    "tokens",
  ]) {
    const metric = validMetric(value[name]);
    if (metric !== undefined) {
      metrics[name] = metric;
    }
  }
  return metrics;
}

function numericMetricContributions(
  value: Record<string, unknown>,
): Record<string, Record<string, number>> {
  const contributions: Record<string, Record<string, number>> = {};
  for (const [idempotencyKey, contribution] of Object.entries(value)) {
    if (isObject(contribution)) {
      contributions[idempotencyKey] = numericMetrics(contribution);
    }
  }
  return contributions;
}

function modelMetadata(
  modelId: string,
  providerId: string,
): Record<string, unknown> {
  const provider = providerId.split(".")[0]?.trim();
  const model = modelId.trim();
  return {
    ...(model.length === 0 ? {} : { model }),
    ...(provider === undefined || provider.length === 0 ? {} : { provider }),
  };
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }
  if (isObject(error) && typeof error["message"] === "string") {
    const code = typeof error["code"] === "string" ? error["code"] + ": " : "";
    const result = new Error(code + error["message"]);
    result.cause = error;
    return result;
  }
  const result = new Error(fallback);
  if (error !== undefined) {
    result.cause = error;
  }
  return result;
}

function actionEndArgs(
  acceptedAtMs: number | undefined,
): { endTime: number } | undefined {
  return typeof acceptedAtMs === "number" && Number.isFinite(acceptedAtMs)
    ? { endTime: acceptedAtMs / 1000 }
    : undefined;
}

function turnKey(sessionId: string, turnId: string): string {
  return sessionId + ":" + turnId;
}

async function generateEveIds(
  kind: "action" | "step" | "turn",
  ...parts: string[]
): Promise<{ rowId: string; spanId: string }> {
  const [rowId, spanId] = await Promise.all([
    deterministicEveId("eve:row:" + kind, ...parts),
    deterministicEveId("eve:" + kind, ...parts),
  ]);
  return { rowId, spanId };
}

async function deterministicEveId(...parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(
    parts.map((part) => part.length + ":" + part).join("\0"),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest, 0, 16));
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}
