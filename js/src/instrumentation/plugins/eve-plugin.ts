import { debugLogger } from "../../debug-logger";
import {
  NOOP_SPAN,
  _internalStartSpanWithInitialMerge,
  currentSpan,
  flush,
  updateSpan,
  withCurrent,
} from "../../logger";
import type { Span } from "../../logger";
import { LRUCache } from "../../lru-cache";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  EveAssistantStepFinishReason,
  EveActionResultError,
  EveHandleMessageStreamEvent,
  EveHookContext,
  EveHookDefinition,
  EveInstrumentationDefinition,
  EveInstrumentationStepStartedEventInput,
  EveRuntimeActionRequest,
  EveRuntimeActionResult,
  EveRuntimeToolCallActionRequest,
  EveRuntimeToolResultActionResult,
} from "../../vendor-sdk-types/eve";

type SpanState = {
  metadata: Record<string, unknown>;
  span: EveSpan;
};

type EveSpan = Pick<Span, "end" | "log" | "rootSpanId" | "spanId">;

type EveSpanStartEvent = {
  readonly created: string;
  readonly metrics: { readonly start: number };
  readonly span_attributes: Record<string, unknown>;
  readonly span_parents: string[];
};

type EveSpanReference = {
  readonly endTime?: number;
  readonly exported: string;
  readonly rootSpanId: string;
  readonly rowId: string;
  readonly spanId: string;
  readonly startEvent?: EveSpanStartEvent;
};

type SessionState = SpanState & {
  sessionId: string;
};

type StepState = SpanState & {
  input?: unknown;
  metrics: Record<string, number>;
  output?: unknown;
};

type TurnState = SpanState & {
  key: string;
  metrics: Record<string, number>;
  output?: unknown;
  stepsByIndex: Map<number, StepState>;
  turnId: string;
};

type ToolState = SpanState & {
  endedByTurn?: boolean;
  turnKey: string;
};

type ParentLineage = {
  callId: string;
  rootSessionId: string;
  sessionId: string;
};

type EveEntityKind = "session" | "step" | "subagent" | "tool" | "turn";

type EveStateHandle<T> = {
  get(): T;
  update(fn: (current: T) => T): void;
};

type EveDefineState = <T>(name: string, initial: () => T) => EveStateHandle<T>;

type EveTraceState = {
  metadata: Record<string, unknown>;
  spanReferences: readonly EveSpanReference[];
  stepStarts: readonly {
    ordinal: number;
    open: boolean;
    stepIndex: number;
    turnId: string;
  }[];
  llmInputs: readonly {
    input: CapturedEveModelInput;
    key: string;
  }[];
};

const EVE_TRACE_STATE_KEY = "braintrust.eve.tracing";
const MAX_EVE_CACHE_ENTRIES = 10_000;
const MAX_STORED_LLM_INPUTS = 100;
const MAX_STORED_SPAN_REFERENCES = 10_000;
const MAX_STORED_STEP_STARTS = 10_000;

type CapturedEveModelInput = readonly unknown[];

/** Manual hook instrumentation for eve runtime stream events. */
export function braintrustEveHook(options: {
  defineState: EveDefineState;
  metadata?: Record<string, unknown>;
}): EveHookDefinition {
  const state = options.defineState(EVE_TRACE_STATE_KEY, emptyEveTraceState);
  const bridge = new EveBridge(state);
  return {
    events: {
      "*": async (event: EveHandleMessageStreamEvent, ctx: EveHookContext) => {
        await bridge.handle(event, ctx, options.metadata);
      },
    },
  };
}

/** Eve instrumentation helper for logger setup and durable LLM input capture. */
export function braintrustEveInstrumentation(options: {
  defineState: EveDefineState;
  setup?: EveInstrumentationDefinition["setup"];
}): EveInstrumentationDefinition {
  const state = options.defineState(EVE_TRACE_STATE_KEY, emptyEveTraceState);
  return {
    events: {
      "step.started": (input: EveInstrumentationStepStartedEventInput) => {
        try {
          captureEveModelInput(state, input);
        } catch (error) {
          debugLogger.warn("Error in Eve LLM input capture:", error);
        }
      },
    },
    recordInputs: false,
    recordOutputs: false,
    setup: options.setup,
  };
}

function isEveHandleMessageStreamEvent(
  event: unknown,
): event is EveHandleMessageStreamEvent {
  return isObject(event) && typeof event["type"] === "string";
}

class ResumedEveSpan implements EveSpan {
  private endTime: number | undefined;

  constructor(private readonly reference: EveSpanReference) {
    this.endTime = reference.endTime;
  }

  get rootSpanId(): string {
    return this.reference.rootSpanId;
  }

  get spanId(): string {
    return this.reference.spanId;
  }

  log(event: Parameters<Span["log"]>[0]): void {
    const metrics = {
      ...this.reference.startEvent?.metrics,
      ...(this.endTime === undefined ? {} : { end: this.endTime }),
      ...event.metrics,
    };
    updateSpan({
      exported: this.reference.exported,
      ...this.reference.startEvent,
      ...event,
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
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
  constructor(private readonly state: EveStateHandle<EveTraceState>) {}

  private eventQueuesBySession = new Map<string, Promise<void>>();
  private sessionsById = new LRUCache<string, SessionState>({
    max: MAX_EVE_CACHE_ENTRIES,
  });
  private completedToolKeys = new LRUCache<string, true>({
    max: MAX_EVE_CACHE_ENTRIES,
  });
  private toolsByCallKey = new LRUCache<string, ToolState>({
    max: MAX_EVE_CACHE_ENTRIES,
  });
  private turnsByKey = new LRUCache<string, TurnState>({
    max: MAX_EVE_CACHE_ENTRIES,
  });

  private async startEveSpan(
    args: Parameters<typeof _internalStartSpanWithInitialMerge>[0],
  ): Promise<EveSpan> {
    const rowId = args?.event?.id;
    const reference =
      typeof rowId === "string" &&
      readEveTraceState(this.state).spanReferences.find(
        (candidate) => candidate.rowId === rowId,
      );
    if (reference) {
      return new ResumedEveSpan(reference);
    }

    const startTime = args?.startTime ?? getCurrentUnixTimestamp();
    const parentSpanIds = args?.parentSpanIds;
    const startEvent: EveSpanStartEvent = {
      created: new Date().toISOString(),
      metrics: { start: startTime },
      span_attributes: {
        ...(args?.name ? { name: args.name } : {}),
        ...(args?.type ? { type: args.type } : {}),
        ...args?.spanAttributes,
      },
      span_parents: parentSpanIds
        ? "spanId" in parentSpanIds
          ? [parentSpanIds.spanId]
          : parentSpanIds.parentSpanIds
        : [],
    };
    const span = withCurrent(NOOP_SPAN, () =>
      _internalStartSpanWithInitialMerge({ ...args, startTime }),
    );
    if (typeof rowId !== "string") {
      return span;
    }

    try {
      const exported = await span.export();
      const reference = {
        exported,
        rootSpanId: span.rootSpanId,
        rowId,
        spanId: span.spanId,
        startEvent,
      };
      this.state.update((current) => {
        const normalized = normalizeEveTraceState(current);
        return normalized.spanReferences.some(
          (candidate) => candidate.rowId === rowId,
        )
          ? normalized
          : {
              ...normalized,
              spanReferences: [...normalized.spanReferences, reference].slice(
                -MAX_STORED_SPAN_REFERENCES,
              ),
            };
      });
    } catch (error) {
      debugLogger.warn("Error exporting Eve span for resumption:", error);
    }
    return span;
  }

  private async startEveChildSpan(
    parent: EveSpan,
    args: Parameters<typeof _internalStartSpanWithInitialMerge>[0],
  ): Promise<EveSpan> {
    return await this.startEveSpan({
      ...args,
      parentSpanIds: {
        rootSpanId: parent.rootSpanId,
        spanId: parent.spanId,
      },
    });
  }

  private stepOrdinal(
    event: Extract<EveHandleMessageStreamEvent, { type: "step.started" }>,
  ): number {
    let ordinal = 0;
    this.state.update((current) => {
      const state = normalizeEveTraceState(current);
      const previous = state.stepStarts
        .filter(
          (entry) =>
            entry.turnId === event.data.turnId &&
            entry.stepIndex === event.data.stepIndex,
        )
        .at(-1);
      if (previous?.open) {
        ordinal = previous.ordinal;
        return state;
      }

      ordinal = state.stepStarts.filter(
        (entry) => entry.turnId === event.data.turnId,
      ).length;
      return {
        ...state,
        stepStarts: [
          ...state.stepStarts,
          {
            open: true,
            ordinal,
            stepIndex: event.data.stepIndex,
            turnId: event.data.turnId,
          },
        ].slice(-MAX_STORED_STEP_STARTS),
      };
    });
    return ordinal;
  }

  private markStepEnded(turnId: string, stepIndex: number): void {
    this.state.update((current) => {
      const state = normalizeEveTraceState(current);
      let index = -1;
      for (let i = state.stepStarts.length - 1; i >= 0; i--) {
        const entry = state.stepStarts[i];
        if (entry?.turnId === turnId && entry.stepIndex === stepIndex) {
          index = i;
          break;
        }
      }
      if (index < 0 || !state.stepStarts[index]?.open) {
        return state;
      }
      return {
        ...state,
        stepStarts: state.stepStarts.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, open: false } : entry,
        ),
      };
    });
  }

  async handle(
    event: unknown,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!isEveHandleMessageStreamEvent(event)) {
      return;
    }
    const run = async () => {
      try {
        if (!(await this.handleEvent(event, ctx, hookMetadata))) {
          return;
        }
        if (event.type === "session.failed") {
          const sessionId = event.data.sessionId || sessionIdFromContext(ctx);
          await this.flushInstrumentation();
          if (sessionId) {
            this.cleanupSession(sessionId);
          }
        } else if (event.type === "session.completed") {
          const sessionId = sessionIdFromContext(ctx);
          await this.flushInstrumentation();
          if (sessionId) {
            this.cleanupSession(sessionId);
          }
        }
      } catch (error) {
        debugLogger.warn("Error in Eve hook instrumentation:", error);
      }
    };

    const sessionId =
      event.type === "session.failed"
        ? event.data.sessionId || sessionIdFromContext(ctx)
        : sessionIdFromContext(ctx);
    if (!sessionId) {
      await run();
      return;
    }

    const previous = this.eventQueuesBySession.get(sessionId);
    const queued = previous ? previous.then(run) : run();
    this.eventQueuesBySession.set(sessionId, queued);
    try {
      await queued;
    } finally {
      if (this.eventQueuesBySession.get(sessionId) === queued) {
        this.eventQueuesBySession.delete(sessionId);
      }
    }
  }

  private async handleEvent(
    event: EveHandleMessageStreamEvent,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<boolean> {
    switch (event.type) {
      case "session.started":
        await this.handleSessionStarted(event, ctx, hookMetadata);
        return true;
      case "turn.started":
        await this.handleTurnStarted(event, ctx, hookMetadata);
        return true;
      case "message.received":
        await this.handleMessageReceived(event, ctx, hookMetadata);
        return true;
      case "step.started":
        await this.handleStepStarted(event, ctx, hookMetadata);
        return true;
      case "message.completed":
        this.handleMessageCompleted(event, ctx);
        return true;
      case "result.completed":
        this.handleResultCompleted(event, ctx);
        return true;
      case "actions.requested":
        await this.handleActionsRequested(event, ctx, hookMetadata);
        return true;
      case "action.result":
        await this.handleActionResult(event, ctx, hookMetadata);
        return true;
      case "subagent.called":
        await this.handleSubagentCalled(event, ctx, hookMetadata);
        return true;
      case "subagent.completed":
        await this.handleSubagentCompleted(event, ctx, hookMetadata);
        return true;
      case "step.completed":
        this.handleStepCompleted(event, ctx);
        return true;
      case "step.failed":
        this.handleStepFailed(event, ctx);
        return true;
      case "turn.completed":
        await this.handleTurnCompleted(event, ctx);
        return true;
      case "turn.failed":
        await this.handleTurnFailed(event, ctx);
        return true;
      case "session.failed":
        await this.handleSessionFailed(event, ctx);
        return true;
      case "session.completed":
        await this.handleSessionCompleted(event, ctx);
        return true;
      default:
        return false;
    }
  }

  private async handleSessionStarted(
    event: Extract<EveHandleMessageStreamEvent, { type: "session.started" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    const metadata = {
      ...(hookMetadata ?? {}),
      ...modelMetadataFromRuntime(event.data.runtime),
    };
    this.state.update((current) => {
      const normalized = normalizeEveTraceState(current);
      return {
        ...normalized,
        metadata: { ...normalized.metadata, ...metadata },
      };
    });
    await this.ensureSession(sessionId, ctx, metadata, eventTime(event));
    for (const [key, turn] of this.turnsByKey) {
      if (!key.startsWith(`${sessionId}:`)) {
        continue;
      }

      turn.metadata = { ...turn.metadata, ...metadata };
      turn.span.log({ metadata: turn.metadata });
      for (const step of turn.stepsByIndex.values()) {
        step.metadata = { ...step.metadata, ...metadata };
        step.span.log({ metadata: step.metadata });
      }
    }
  }

  private async handleTurnStarted(
    event: Extract<EveHandleMessageStreamEvent, { type: "turn.started" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    const session = await this.ensureSession(
      sessionId,
      ctx,
      hookMetadata ?? {},
      eventTime(event),
    );
    const key = turnKey(sessionId, event.data.turnId);
    const metadata = { ...session.metadata };
    const existing = this.turnsByKey.get(key);
    if (existing) {
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.span.log({ metadata: existing.metadata });
      return;
    }

    const span = await this.startTurnSpan(session, event, metadata);
    span.log({ metadata });
    this.turnsByKey.set(key, {
      key,
      metadata,
      metrics: {},
      span,
      stepsByIndex: new Map(),
      turnId: event.data.turnId,
    });
  }

  private async handleMessageReceived(
    event: Extract<EveHandleMessageStreamEvent, { type: "message.received" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const turn = await this.ensureTurn(event, ctx, hookMetadata);
    if (!turn) {
      return;
    }

    const input = [{ content: event.data.message, role: "user" }];
    turn.span.log({ input });
  }

  private async handleStepStarted(
    event: Extract<EveHandleMessageStreamEvent, { type: "step.started" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const turn = await this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return;
    }

    const existing = turn.stepsByIndex.get(event.data.stepIndex);
    if (existing) {
      existing.span.log({
        ...(existing.input !== undefined ? { input: existing.input } : {}),
        metadata: existing.metadata,
        metrics: existing.metrics,
        output: existing.output,
      });
      const endTime = eventTime(event);
      existing.span.end(endTime === undefined ? undefined : { endTime });
      this.markStepEnded(event.data.turnId, event.data.stepIndex);
    }

    const stepOrdinal = this.stepOrdinal(event);
    const metadata = {
      ...turn.metadata,
      ...(this.sessionsById.get(sessionId)?.metadata ?? {}),
    };
    const input = consumeCapturedEveModelInput(
      this.state,
      sessionId,
      event.data.turnId,
      event.data.stepIndex,
    );
    const { rowId: eventId, spanId } = await generateEveIds(
      "step",
      sessionId,
      event.data.turnId,
      String(stepOrdinal),
    );
    const span = await this.startEveChildSpan(turn.span, {
      event: {
        id: eventId,
        ...(input !== undefined ? { input } : {}),
        metadata,
      },
      name: "eve.step",
      spanAttributes: { type: SpanTypeAttribute.LLM },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ ...(input !== undefined ? { input } : {}), metadata });

    turn.stepsByIndex.set(event.data.stepIndex, {
      ...(input !== undefined ? { input } : {}),
      metadata,
      metrics: {},
      span,
    });
  }

  private handleMessageCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "message.completed" }>,
    ctx: unknown,
  ): void {
    const step = this.stepForEvent(event, ctx);
    if (!step) {
      return;
    }

    const existingMessage =
      Array.isArray(step.output) && isObject(step.output[0])
        ? step.output[0].message
        : undefined;
    const existingToolCalls = isObject(existingMessage)
      ? existingMessage.tool_calls
      : undefined;
    step.output = [
      {
        finish_reason: normalizedFinishReason(event.data.finishReason),
        index: 0,
        message: {
          content: event.data.message,
          role: "assistant",
          ...(Array.isArray(existingToolCalls)
            ? { tool_calls: existingToolCalls }
            : {}),
        },
      },
    ];

    const turn = this.turnForEvent(event, ctx);
    if (turn && event.data.finishReason !== "tool-calls") {
      turn.output = event.data.message;
    }
  }

  private handleResultCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "result.completed" }>,
    ctx: unknown,
  ): void {
    const step = this.stepForEvent(event, ctx);
    if (step) {
      step.output = [
        {
          finish_reason: "stop",
          index: 0,
          message: {
            content: event.data.result,
            role: "assistant",
          },
        },
      ];
    }

    const turn = this.turnForEvent(event, ctx);
    if (turn) {
      turn.output = event.data.result;
    }
  }

  private async handleActionsRequested(
    event: Extract<EveHandleMessageStreamEvent, { type: "actions.requested" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const turn = await this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return;
    }

    const traceActions = event.data.actions.filter(isTraceableActionRequest);
    if (traceActions.length === 0) {
      return;
    }

    for (const action of traceActions) {
      if (isToolCallAction(action)) {
        await this.startRequestedTool(event, turn, sessionId, action);
      } else if (isLocalSubagentCallAction(action)) {
        await this.startRequestedSubagent(event, turn, sessionId, action);
      }
    }

    const step = turn.stepsByIndex.get(event.data.stepIndex);
    if (!step) {
      return;
    }

    step.output = [
      {
        finish_reason: "tool_calls",
        index: 0,
        message: {
          content: null,
          role: "assistant",
          tool_calls: traceActions.map((action) => {
            const name =
              action.kind === "tool-call"
                ? action.toolName
                : (action.subagentName ?? action.name ?? "agent");
            return {
              function: {
                arguments: JSON.stringify(action.input),
                name,
              },
              id: action.callId,
              type: "function",
            };
          }),
        },
      },
    ];
    step.span.log({ metadata: step.metadata, output: step.output });
  }

  private async handleActionResult(
    event: Extract<EveHandleMessageStreamEvent, { type: "action.result" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    if (isToolResult(event.data.result)) {
      await this.handleToolResult(event, ctx, event.data.result, hookMetadata);
      return;
    }
    if (isSubagentResult(event.data.result)) {
      await this.handleSubagentResult(
        event,
        ctx,
        event.data.result,
        hookMetadata,
      );
    }
  }

  private async handleToolResult(
    event: Extract<EveHandleMessageStreamEvent, { type: "action.result" }>,
    ctx: unknown,
    result: EveRuntimeToolResultActionResult,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    const key = toolKey(sessionId, result.callId);
    if (this.completedToolKeys.has(key)) {
      return;
    }
    const tool =
      this.toolsByCallKey.get(key) ??
      (await this.startSyntheticTool(event, ctx, result, hookMetadata));
    if (!tool) {
      return;
    }
    const failed =
      event.data.status === "failed" ||
      result.isError === true ||
      event.data.error !== undefined;
    tool.span.log({
      ...(failed
        ? {
            error: actionResultError(event.data.error, result.output),
          }
        : {}),
      metadata: tool.metadata,
      output: result.output,
    });

    const endTime = eventTime(event);
    tool.span.end(endTime === undefined ? undefined : { endTime });
    this.toolsByCallKey.delete(key);
    this.completedToolKeys.set(key, true);
  }

  private async handleSubagentCalled(
    event: Extract<EveHandleMessageStreamEvent, { type: "subagent.called" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    if (event.data.remote?.url) {
      return;
    }

    const turn = await this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return;
    }

    const key = toolKey(sessionId, event.data.callId);
    const metadata = toolMetadataFromTurn(turn);
    const existing = this.toolsByCallKey.get(key);
    if (existing) {
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.span.log({ metadata: existing.metadata });
      return;
    }
    if (this.completedToolKeys.has(key)) {
      return;
    }

    const { rowId: eventId, spanId } = await generateEveIds(
      "subagent",
      sessionId,
      event.data.callId,
    );
    const pending = this.toolsByCallKey.get(key);
    if (pending || this.completedToolKeys.has(key)) {
      if (pending) {
        pending.metadata = { ...pending.metadata, ...metadata };
        pending.span.log({ metadata: pending.metadata });
      }
      return;
    }
    const span = await this.startEveChildSpan(turn.span, {
      event: {
        id: eventId,
        metadata,
      },
      name: event.data.toolName ?? event.data.name,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ metadata });
    this.toolsByCallKey.set(key, {
      metadata,
      span,
      turnKey: turnKey(sessionId, event.data.turnId),
    });
  }

  private async handleSubagentCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "subagent.completed" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    const key = toolKey(sessionId, event.data.callId);
    if (this.completedToolKeys.has(key)) {
      return;
    }
    const subagent =
      this.toolsByCallKey.get(key) ??
      (await this.startSyntheticSubagent(event, ctx, hookMetadata));
    if (!subagent) {
      return;
    }
    subagent.span.log({
      ...(event.data.status === "failed"
        ? {
            error: actionResultError(event.data.error, event.data.output),
          }
        : {}),
      metadata: subagent.metadata,
      ...(event.data.output !== undefined ? { output: event.data.output } : {}),
    });
    const endTime = eventTime(event);
    const recordedEndTime = subagent.span.end(
      endTime === undefined ? undefined : { endTime },
    );
    this.state.update((current) => {
      const normalized = normalizeEveTraceState(current);
      return {
        ...normalized,
        spanReferences: normalized.spanReferences.map((reference) =>
          reference.spanId === subagent.span.spanId
            ? { ...reference, endTime: recordedEndTime }
            : reference,
        ),
      };
    });
  }

  private async handleSubagentResult(
    event: Extract<EveHandleMessageStreamEvent, { type: "action.result" }>,
    ctx: unknown,
    result: Extract<EveRuntimeActionResult, { kind: "subagent-result" }>,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    const key = toolKey(sessionId, result.callId);
    if (this.completedToolKeys.has(key)) {
      return;
    }
    const subagent =
      this.toolsByCallKey.get(key) ??
      (await this.startSyntheticSubagentResult(
        event,
        ctx,
        result,
        hookMetadata,
      ));
    if (!subagent) {
      return;
    }
    const isError =
      event.data.status === "failed" ||
      result.isError === true ||
      event.data.error !== undefined;
    subagent.span.log({
      ...(isError
        ? {
            error: actionResultError(event.data.error, result.output),
          }
        : {}),
      metadata: subagent.metadata,
      output: result.output,
    });
    const endTime = eventTime(event);
    subagent.span.end(endTime === undefined ? undefined : { endTime });

    this.toolsByCallKey.delete(key);
    this.completedToolKeys.set(key, true);
  }

  private handleStepCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "step.completed" }>,
    ctx: unknown,
  ): void {
    const step = this.stepForEvent(event, ctx);
    if (!step) {
      return;
    }

    const usage = event.data.usage;
    const inputTokens =
      typeof usage?.inputTokens === "number" &&
      Number.isFinite(usage.inputTokens) &&
      usage.inputTokens >= 0
        ? usage.inputTokens
        : undefined;
    const outputTokens =
      typeof usage?.outputTokens === "number" &&
      Number.isFinite(usage.outputTokens) &&
      usage.outputTokens >= 0
        ? usage.outputTokens
        : undefined;
    const cacheReadTokens =
      typeof usage?.cacheReadTokens === "number" &&
      Number.isFinite(usage.cacheReadTokens) &&
      usage.cacheReadTokens >= 0
        ? usage.cacheReadTokens
        : undefined;
    const cacheWriteTokens =
      typeof usage?.cacheWriteTokens === "number" &&
      Number.isFinite(usage.cacheWriteTokens) &&
      usage.cacheWriteTokens >= 0
        ? usage.cacheWriteTokens
        : undefined;
    const costUsd =
      typeof usage?.costUsd === "number" &&
      Number.isFinite(usage.costUsd) &&
      usage.costUsd >= 0
        ? usage.costUsd
        : undefined;
    const total =
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined;
    const metrics = {
      ...(inputTokens !== undefined ? { prompt_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined
        ? { completion_tokens: outputTokens }
        : {}),
      ...(total !== undefined ? { tokens: total } : {}),
      ...(cacheReadTokens !== undefined
        ? { prompt_cached_tokens: cacheReadTokens }
        : {}),
      ...(cacheWriteTokens !== undefined
        ? { prompt_cache_creation_tokens: cacheWriteTokens }
        : {}),
      ...(costUsd !== undefined ? { estimated_cost: costUsd } : {}),
    };
    step.metrics = { ...step.metrics, ...metrics };
    if (Array.isArray(step.output) && isObject(step.output[0])) {
      const finishReason = step.output[0].finish_reason;
      if (typeof finishReason !== "string") {
        step.output[0].finish_reason = normalizedFinishReason(
          event.data.finishReason,
        );
      }
    }
    step.span.log({
      ...(step.input !== undefined ? { input: step.input } : {}),
      metadata: step.metadata,
      metrics,
      output: step.output,
    });
    const endTime = eventTime(event);
    step.span.end(endTime === undefined ? undefined : { endTime });

    const turn = this.turnForEvent(event, ctx);
    if (turn) {
      for (const [key, value] of Object.entries(metrics)) {
        turn.metrics[key] = (turn.metrics[key] ?? 0) + value;
      }
      turn.stepsByIndex.delete(event.data.stepIndex);
    }
    this.markStepEnded(event.data.turnId, event.data.stepIndex);
  }

  private handleStepFailed(
    event: Extract<EveHandleMessageStreamEvent, { type: "step.failed" }>,
    ctx: unknown,
  ): void {
    const step = this.stepForEvent(event, ctx);
    if (step) {
      step.span.log({
        error: errorFromMessage(
          event.data.message,
          event.data.code,
          event.data.details,
        ),
      });
      const endTime = eventTime(event);
      step.span.end(endTime === undefined ? undefined : { endTime });
    }

    const turn = this.turnForEvent(event, ctx);
    turn?.stepsByIndex.delete(event.data.stepIndex);
    this.markStepEnded(event.data.turnId, event.data.stepIndex);
  }

  private handleTurnCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "turn.completed" }>,
    ctx: unknown,
  ): void {
    const turn = this.turnForEvent(event, ctx);
    if (!turn) {
      return;
    }

    this.finalizeTurn(turn, {
      endTime: eventTime(event),
    });
  }

  private handleTurnFailed(
    event: Extract<EveHandleMessageStreamEvent, { type: "turn.failed" }>,
    ctx: unknown,
  ): void {
    const turn = this.turnForEvent(event, ctx);
    if (!turn) {
      return;
    }

    this.finalizeTurn(turn, {
      endTime: eventTime(event),
      error: errorFromMessage(
        event.data.message,
        event.data.code,
        event.data.details,
      ),
    });
  }

  private async handleSessionFailed(
    event: Extract<EveHandleMessageStreamEvent, { type: "session.failed" }>,
    ctx: unknown,
  ): Promise<void> {
    const sessionId = event.data.sessionId || sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }
    const session = await this.ensureSession(
      sessionId,
      ctx,
      {},
      eventTime(event),
    );

    const error = errorFromMessage(
      event.data.message,
      event.data.code,
      event.data.details,
    );
    for (const [key, turn] of this.turnsByKey) {
      if (!key.startsWith(`${sessionId}:`)) {
        continue;
      }
      this.finalizeTurn(turn, {
        endTime: eventTime(event),
        error,
      });
    }

    for (const [key, tool] of this.toolsByCallKey) {
      if (key.startsWith(`${sessionId}:`)) {
        const endTime = eventTime(event);
        if (!tool.endedByTurn) {
          tool.span.log({ metadata: tool.metadata });
          tool.span.end(endTime === undefined ? undefined : { endTime });
          tool.endedByTurn = true;
        }
      }
    }

    session.span.log({ error });
    const endTime = eventTime(event);
    session.span.end(endTime === undefined ? undefined : { endTime });
  }

  private async handleSessionCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "session.completed" }>,
    ctx: unknown,
  ): Promise<void> {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }
    const session = await this.ensureSession(
      sessionId,
      ctx,
      {},
      eventTime(event),
    );

    for (const [key, turn] of this.turnsByKey) {
      if (!key.startsWith(`${sessionId}:`)) {
        continue;
      }
      this.finalizeTurn(turn, {
        endTime: eventTime(event),
      });
    }

    for (const [key, tool] of this.toolsByCallKey) {
      if (key.startsWith(`${sessionId}:`) && !tool.endedByTurn) {
        const endTime = eventTime(event);
        tool.span.log({ metadata: tool.metadata });
        tool.span.end(endTime === undefined ? undefined : { endTime });
        tool.endedByTurn = true;
      }
    }
    session.span.log({ metadata: session.metadata });
    const endTime = eventTime(event);
    session.span.end(endTime === undefined ? undefined : { endTime });
  }

  private async ensureSession(
    sessionId: string,
    ctx: unknown,
    metadata: Record<string, unknown>,
    startTime?: number,
  ): Promise<SessionState> {
    metadata = {
      ...readEveTraceState(this.state).metadata,
      ...metadata,
    };
    const existing = this.sessionsById.get(sessionId);
    if (existing) {
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.span.log({ metadata: existing.metadata });
      return existing;
    }

    const lineage = parentLineageFromContext(ctx);
    // A child session has its own durable Eve context. It can link to the
    // deterministic parent subagent span, but must not upsert that row itself.
    const parentSubagent = lineage
      ? this.toolsByCallKey.get(toolKey(lineage.sessionId, lineage.callId))
      : undefined;
    const activeParent = currentSpan();
    const [
      { rowId: eventId, spanId },
      parentSubagentSpanId,
      fallbackRootSpanId,
    ] = await Promise.all([
      generateEveIds("session", sessionId),
      lineage
        ? spanIdForSubagent(lineage.sessionId, lineage.callId)
        : Promise.resolve(undefined),
      lineage
        ? rootSpanIdForSession(lineage.rootSessionId)
        : rootSpanIdForSession(sessionId),
    ]);

    const span = await this.startEveSpan({
      event: {
        id: eventId,
        metadata,
      },
      name: "eve.session",
      parentSpanIds:
        lineage && parentSubagentSpanId
          ? {
              rootSpanId: parentSubagent?.span.rootSpanId ?? fallbackRootSpanId,
              spanId: parentSubagentSpanId,
            }
          : !Object.is(activeParent, NOOP_SPAN)
            ? {
                rootSpanId: activeParent.rootSpanId,
                spanId: activeParent.spanId,
              }
            : {
                parentSpanIds: [],
                rootSpanId: fallbackRootSpanId,
              },
      spanAttributes: { type: SpanTypeAttribute.TASK },
      spanId,
      startTime,
    });
    span.log({ metadata });
    const session = { metadata, sessionId, span };
    this.sessionsById.set(sessionId, session);
    return session;
  }

  private async ensureTurn(
    event: Extract<
      EveHandleMessageStreamEvent,
      {
        data: { readonly sequence: number; readonly turnId: string };
      }
    >,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<TurnState | undefined> {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return undefined;
    }

    const session = await this.ensureSession(
      sessionId,
      ctx,
      hookMetadata ?? {},
      eventTime(event),
    );
    const key = turnKey(sessionId, event.data.turnId);
    const existing = this.turnsByKey.get(key);
    if (existing) {
      return existing;
    }

    const metadata = { ...session.metadata };
    const span = await this.startTurnSpan(session, event, metadata);
    span.log({ metadata });
    const state = {
      key,
      metadata,
      metrics: {},
      span,
      stepsByIndex: new Map<number, StepState>(),
      turnId: event.data.turnId,
    };
    this.turnsByKey.set(key, state);
    return state;
  }

  private async startRequestedTool(
    event: Extract<EveHandleMessageStreamEvent, { type: "actions.requested" }>,
    turn: TurnState,
    sessionId: string,
    action: EveRuntimeToolCallActionRequest,
  ): Promise<void> {
    const key = toolKey(sessionId, action.callId);
    if (this.toolsByCallKey.has(key) || this.completedToolKeys.has(key)) {
      return;
    }

    const metadata = toolMetadataFromTurn(turn);
    const { rowId: eventId, spanId } = await generateEveIds(
      "tool",
      sessionId,
      event.data.turnId,
      action.callId,
    );
    if (this.toolsByCallKey.has(key) || this.completedToolKeys.has(key)) {
      return;
    }
    const span = await this.startEveChildSpan(turn.span, {
      event: {
        id: eventId,
        input: action.input,
        metadata,
      },
      name: action.toolName,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ input: action.input, metadata });
    this.toolsByCallKey.set(key, {
      metadata,
      span,
      turnKey: turnKey(sessionId, event.data.turnId),
    });
  }

  private async startRequestedSubagent(
    event: Extract<EveHandleMessageStreamEvent, { type: "actions.requested" }>,
    turn: TurnState,
    sessionId: string,
    action: Extract<EveRuntimeActionRequest, { kind: "subagent-call" }>,
  ): Promise<void> {
    const key = toolKey(sessionId, action.callId);
    if (this.toolsByCallKey.has(key) || this.completedToolKeys.has(key)) {
      return;
    }

    const name = action.subagentName ?? action.name ?? "agent";
    const metadata = toolMetadataFromTurn(turn);
    const { rowId: eventId, spanId } = await generateEveIds(
      "subagent",
      sessionId,
      action.callId,
    );
    if (this.toolsByCallKey.has(key) || this.completedToolKeys.has(key)) {
      return;
    }
    const span = await this.startEveChildSpan(turn.span, {
      event: {
        id: eventId,
        input: action.input,
        metadata,
      },
      name,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ input: action.input, metadata });
    this.toolsByCallKey.set(key, {
      metadata,
      span,
      turnKey: turnKey(sessionId, event.data.turnId),
    });
  }

  private async startSyntheticTool(
    event: Extract<EveHandleMessageStreamEvent, { type: "action.result" }>,
    ctx: unknown,
    result: EveRuntimeToolResultActionResult,
    hookMetadata?: Record<string, unknown>,
  ): Promise<ToolState | undefined> {
    const turn = await this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return undefined;
    }

    const metadata = toolMetadataFromTurn(turn);
    const { rowId: eventId, spanId } = await generateEveIds(
      "tool",
      sessionId,
      event.data.turnId,
      result.callId,
    );
    const existing = this.toolsByCallKey.get(toolKey(sessionId, result.callId));
    if (existing) {
      return existing;
    }
    const span = await this.startEveChildSpan(turn.span, {
      event: {
        id: eventId,
        metadata,
      },
      name: result.toolName,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ metadata });
    const state = {
      metadata,
      span,
      turnKey: turnKey(sessionId, event.data.turnId),
    };
    this.toolsByCallKey.set(toolKey(sessionId, result.callId), state);
    return state;
  }

  private async startSyntheticSubagent(
    event: Extract<EveHandleMessageStreamEvent, { type: "subagent.completed" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<ToolState | undefined> {
    const turn = await this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return undefined;
    }

    const metadata = toolMetadataFromTurn(turn);
    const { rowId: eventId, spanId } = await generateEveIds(
      "subagent",
      sessionId,
      event.data.callId,
    );
    const existing = this.toolsByCallKey.get(
      toolKey(sessionId, event.data.callId),
    );
    if (existing) {
      return existing;
    }
    const span = await this.startEveChildSpan(turn.span, {
      event: {
        id: eventId,
        metadata,
      },
      name: event.data.subagentName,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ metadata });
    const state = {
      metadata,
      span,
      turnKey: turnKey(sessionId, event.data.turnId),
    };
    this.toolsByCallKey.set(toolKey(sessionId, event.data.callId), state);
    return state;
  }

  private async startSyntheticSubagentResult(
    event: Extract<EveHandleMessageStreamEvent, { type: "action.result" }>,
    ctx: unknown,
    result: Extract<EveRuntimeActionResult, { kind: "subagent-result" }>,
    hookMetadata?: Record<string, unknown>,
  ): Promise<ToolState | undefined> {
    const turn = await this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return undefined;
    }

    const metadata = toolMetadataFromTurn(turn);
    const { rowId: eventId, spanId } = await generateEveIds(
      "subagent",
      sessionId,
      result.callId,
    );
    const existing = this.toolsByCallKey.get(toolKey(sessionId, result.callId));
    if (existing) {
      return existing;
    }
    const span = await this.startEveChildSpan(turn.span, {
      event: {
        id: eventId,
        metadata,
      },
      name: result.subagentName,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ metadata });
    const state = {
      metadata,
      span,
      turnKey: turnKey(sessionId, event.data.turnId),
    };
    this.toolsByCallKey.set(toolKey(sessionId, result.callId), state);
    return state;
  }

  private async startTurnSpan(
    session: SessionState,
    event: Extract<
      EveHandleMessageStreamEvent,
      { data: { readonly sequence: number; readonly turnId: string } }
    >,
    metadata: Record<string, unknown>,
  ): Promise<EveSpan> {
    const { rowId: eventId, spanId } = await generateEveIds(
      "turn",
      session.sessionId,
      event.data.turnId,
    );

    return await this.startEveSpan({
      event: {
        id: eventId,
        metadata,
      },
      name: "eve.turn",
      parentSpanIds: {
        rootSpanId: session.span.rootSpanId,
        spanId: session.span.spanId,
      },
      spanAttributes: { type: SpanTypeAttribute.TASK },
      spanId,
      startTime: eventTime(event),
    });
  }

  private turnForEvent(
    event: Extract<
      EveHandleMessageStreamEvent,
      { data: { readonly turnId: string } }
    >,
    ctx: unknown,
  ): TurnState | undefined {
    const sessionId = sessionIdFromContext(ctx);
    return sessionId
      ? this.turnsByKey.get(turnKey(sessionId, event.data.turnId))
      : undefined;
  }

  private stepForEvent(
    event: Extract<
      EveHandleMessageStreamEvent,
      { data: { readonly stepIndex: number; readonly turnId: string } }
    >,
    ctx: unknown,
  ): StepState | undefined {
    return this.turnForEvent(event, ctx)?.stepsByIndex.get(
      event.data.stepIndex,
    );
  }

  private finalizeTurn(
    turn: TurnState,
    args: { endTime: number | undefined; error?: Error },
  ): void {
    const { endTime } = args;
    for (const step of turn.stepsByIndex.values()) {
      step.span.log({
        ...(step.input !== undefined ? { input: step.input } : {}),
        metadata: step.metadata,
        metrics: step.metrics,
        output: step.output,
      });
      step.span.end(endTime === undefined ? undefined : { endTime });
    }
    turn.stepsByIndex.clear();

    for (const tool of this.toolsByCallKey.values()) {
      if (tool.turnKey !== turn.key) {
        continue;
      }
      if (tool.endedByTurn) {
        continue;
      }
      tool.span.log({ metadata: tool.metadata });
      tool.span.end(endTime === undefined ? undefined : { endTime });
      tool.endedByTurn = true;
    }

    if (args.error) {
      turn.span.log({ error: args.error });
    } else {
      turn.span.log({
        metadata: turn.metadata,
        metrics: turn.metrics,
        output: turn.output,
      });
    }
    turn.span.end(endTime === undefined ? undefined : { endTime });
    this.turnsByKey.delete(turn.key);
    this.state.update((current) => {
      const normalized = normalizeEveTraceState(current);
      return {
        ...normalized,
        stepStarts: normalized.stepStarts.filter(
          (entry) => entry.turnId !== turn.turnId,
        ),
      };
    });
  }

  private cleanupSession(sessionId: string): void {
    const keyPrefix = `${sessionId}:`;
    this.sessionsById.delete(sessionId);
    for (const key of this.turnsByKey.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.turnsByKey.delete(key);
      }
    }
    for (const key of this.toolsByCallKey.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.toolsByCallKey.delete(key);
      }
    }
    for (const key of this.completedToolKeys.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.completedToolKeys.delete(key);
      }
    }
    this.state.update(() => emptyEveTraceState());
  }

  private async flushInstrumentation(): Promise<boolean> {
    try {
      await flush();
      return true;
    } catch (error) {
      debugLogger.warn("Error in Eve flush instrumentation:", error);
      return false;
    }
  }
}

function emptyEveTraceState(): EveTraceState {
  return {
    llmInputs: [],
    metadata: {},
    spanReferences: [],
    stepStarts: [],
  };
}

function normalizeEveTraceState(state: unknown): EveTraceState {
  if (!isObject(state)) {
    return emptyEveTraceState();
  }
  const metadata = isObject(state["metadata"]) ? state["metadata"] : {};
  const spanReferences = Array.isArray(state["spanReferences"])
    ? state["spanReferences"]
        .flatMap((entry): EveTraceState["spanReferences"] => {
          if (!isObject(entry)) {
            return [];
          }
          const exported = entry["exported"];
          const endTime = entry["endTime"];
          const rootSpanId = entry["rootSpanId"];
          const rowId = entry["rowId"];
          const spanId = entry["spanId"];
          const startEvent = entry["startEvent"];
          const startEventCreated = isObject(startEvent)
            ? startEvent["created"]
            : undefined;
          const startEventMetrics = isObject(startEvent)
            ? startEvent["metrics"]
            : undefined;
          const startEventSpanAttributes = isObject(startEvent)
            ? startEvent["span_attributes"]
            : undefined;
          const startEventSpanParents = isObject(startEvent)
            ? startEvent["span_parents"]
            : undefined;
          const normalizedStartEvent =
            typeof startEventCreated === "string" &&
            isObject(startEventMetrics) &&
            typeof startEventMetrics["start"] === "number" &&
            Number.isFinite(startEventMetrics["start"]) &&
            isObject(startEventSpanAttributes) &&
            Array.isArray(startEventSpanParents) &&
            startEventSpanParents.every(
              (parent): parent is string => typeof parent === "string",
            )
              ? {
                  created: startEventCreated,
                  metrics: { start: startEventMetrics["start"] },
                  span_attributes: { ...startEventSpanAttributes },
                  span_parents: [...startEventSpanParents],
                }
              : undefined;
          return typeof exported === "string" &&
            typeof rootSpanId === "string" &&
            typeof rowId === "string" &&
            typeof spanId === "string"
            ? [
                {
                  ...(typeof endTime === "number" && Number.isFinite(endTime)
                    ? { endTime }
                    : {}),
                  exported,
                  rootSpanId,
                  rowId,
                  spanId,
                  ...(normalizedStartEvent
                    ? { startEvent: normalizedStartEvent }
                    : {}),
                },
              ]
            : [];
        })
        .slice(-MAX_STORED_SPAN_REFERENCES)
    : [];
  const llmInputs = Array.isArray(state["llmInputs"])
    ? state["llmInputs"]
        .flatMap((entry): EveTraceState["llmInputs"] => {
          if (!isObject(entry)) {
            return [];
          }
          const key = entry["key"];
          const input = entry["input"];
          return typeof key === "string" && isCapturedModelInput(input)
            ? [{ input, key }]
            : [];
        })
        .slice(-MAX_STORED_LLM_INPUTS)
    : [];
  const stepStarts = Array.isArray(state["stepStarts"])
    ? state["stepStarts"]
        .flatMap((entry): EveTraceState["stepStarts"] => {
          if (!isObject(entry)) {
            return [];
          }
          const ordinal = entry["ordinal"];
          const open = entry["open"];
          const stepIndex = entry["stepIndex"];
          const turnId = entry["turnId"];
          return typeof ordinal === "number" &&
            Number.isInteger(ordinal) &&
            ordinal >= 0 &&
            typeof open === "boolean" &&
            typeof stepIndex === "number" &&
            Number.isInteger(stepIndex) &&
            typeof turnId === "string"
            ? [{ open, ordinal, stepIndex, turnId }]
            : [];
        })
        .slice(-MAX_STORED_STEP_STARTS)
    : [];
  return { llmInputs, metadata: { ...metadata }, spanReferences, stepStarts };
}

function readEveTraceState(
  state: EveStateHandle<EveTraceState>,
): EveTraceState {
  try {
    return normalizeEveTraceState(state.get());
  } catch {
    return emptyEveTraceState();
  }
}

function captureEveModelInput(
  state: EveStateHandle<EveTraceState>,
  input: EveInstrumentationStepStartedEventInput,
): void {
  if (!isObject(input)) {
    return;
  }
  const session = input["session"];
  const turn = input["turn"];
  const step = input["step"];
  if (!isObject(session) || !isObject(turn) || !isObject(step)) {
    return;
  }

  const sessionId = session["id"];
  const turnId = turn["id"];
  const stepIndex = step["index"];
  if (
    typeof sessionId !== "string" ||
    typeof turnId !== "string" ||
    typeof stepIndex !== "number" ||
    !Number.isInteger(stepIndex)
  ) {
    return;
  }

  const captured = capturedModelInput(input["modelInput"]);
  if (!captured) {
    return;
  }

  const key = llmInputKey(sessionId, turnId, stepIndex);
  state.update((current) => {
    const normalized = normalizeEveTraceState(current);
    const llmInputs = [...normalized.llmInputs, { input: captured, key }];
    return {
      ...normalized,
      llmInputs: llmInputs.slice(-MAX_STORED_LLM_INPUTS),
    };
  });
}

function consumeCapturedEveModelInput(
  state: EveStateHandle<EveTraceState>,
  sessionId: string,
  turnId: string,
  stepIndex: number,
): CapturedEveModelInput | undefined {
  try {
    const key = llmInputKey(sessionId, turnId, stepIndex);
    let input: CapturedEveModelInput | undefined;
    state.update((current) => {
      const normalized = normalizeEveTraceState(current);
      const index = normalized.llmInputs.findIndex(
        (candidate) => candidate.key === key,
      );
      if (index < 0) {
        return normalized;
      }
      input = normalized.llmInputs[index]?.input;
      return {
        ...normalized,
        llmInputs: normalized.llmInputs.filter(
          (_, candidateIndex) => candidateIndex !== index,
        ),
      };
    });
    return input;
  } catch (error) {
    debugLogger.warn("Error in Eve LLM input consumption:", error);
    return undefined;
  }
}

function capturedModelInput(
  modelInput: unknown,
): CapturedEveModelInput | undefined {
  if (!isObject(modelInput)) {
    return undefined;
  }

  const messages = modelInput["messages"];
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const instructions = modelInput["instructions"];
  const value = [
    ...(instructions !== undefined
      ? [{ content: instructions, role: "system" }]
      : []),
    ...messages,
  ];
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    if (!Array.isArray(cloned)) {
      return undefined;
    }
    return cloned;
  } catch {
    return undefined;
  }
}

function isCapturedModelInput(input: unknown): input is CapturedEveModelInput {
  return Array.isArray(input);
}

function llmInputKey(
  sessionId: string,
  turnId: string,
  stepIndex: number,
): string {
  return `${sessionId}\0${turnId}\0${stepIndex}`;
}

function modelMetadataFromRuntime(runtime: unknown): Record<string, unknown> {
  if (!isObject(runtime)) {
    return {};
  }
  const modelId = runtime["modelId"];
  return typeof modelId === "string" ? modelMetadataFromModelId(modelId) : {};
}

function modelMetadataFromModelId(modelId: string): Record<string, unknown> {
  const normalized = modelId.trim();
  if (!normalized) {
    return {};
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex > 0 && slashIndex < normalized.length - 1) {
    return {
      model: normalized.slice(slashIndex + 1),
      provider: normalized.slice(0, slashIndex),
    };
  }

  return {
    model: normalized,
  };
}

function sessionIdFromContext(ctx: unknown): string | undefined {
  if (!isObject(ctx)) {
    return undefined;
  }
  const session = ctx["session"];
  if (!isObject(session)) {
    return undefined;
  }
  const id = session["id"];
  return typeof id === "string" ? id : undefined;
}

function toolMetadataFromTurn(turn: TurnState): Record<string, unknown> {
  const { model: _model, provider: _provider, ...metadata } = turn.metadata;
  return metadata;
}

function parentLineageFromContext(ctx: unknown): ParentLineage | undefined {
  if (!isObject(ctx)) {
    return undefined;
  }
  const session = ctx.session;
  if (!isObject(session)) {
    return undefined;
  }
  const parent = session["parent"];
  if (!isObject(parent)) {
    return undefined;
  }

  const callId = parent["callId"];
  const rootSessionId = parent["rootSessionId"];
  const sessionId = parent["sessionId"];
  if (
    typeof callId !== "string" ||
    typeof rootSessionId !== "string" ||
    typeof sessionId !== "string"
  ) {
    return undefined;
  }

  return { callId, rootSessionId, sessionId };
}

function isToolCallAction(
  action: unknown,
): action is EveRuntimeToolCallActionRequest {
  return (
    isObject(action) &&
    action["kind"] === "tool-call" &&
    typeof action["callId"] === "string" &&
    typeof action["toolName"] === "string" &&
    isObject(action["input"])
  );
}

function isLocalSubagentCallAction(
  action: unknown,
): action is Extract<EveRuntimeActionRequest, { kind: "subagent-call" }> {
  return (
    isObject(action) &&
    action["kind"] === "subagent-call" &&
    typeof action["callId"] === "string" &&
    isObject(action["input"])
  );
}

function isTraceableActionRequest(
  action: unknown,
): action is
  | EveRuntimeToolCallActionRequest
  | Extract<EveRuntimeActionRequest, { kind: "subagent-call" }> {
  return isToolCallAction(action) || isLocalSubagentCallAction(action);
}

function isToolResult(
  result: unknown,
): result is EveRuntimeToolResultActionResult {
  return (
    isObject(result) &&
    result["kind"] === "tool-result" &&
    typeof result["callId"] === "string" &&
    typeof result["toolName"] === "string"
  );
}

function isSubagentResult(
  result: unknown,
): result is Extract<EveRuntimeActionResult, { kind: "subagent-result" }> {
  return (
    isObject(result) &&
    result["kind"] === "subagent-result" &&
    typeof result["callId"] === "string" &&
    typeof result["subagentName"] === "string"
  );
}

function normalizedFinishReason(
  finishReason: EveAssistantStepFinishReason,
): string {
  switch (finishReason) {
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    default:
      return finishReason;
  }
}

function errorFromMessage(
  message: string,
  code: string,
  details?: unknown,
): Error {
  const error = new Error(`${code}: ${message}`);
  if (details !== undefined) {
    error.cause = details;
  }
  return error;
}

function actionResultError(
  error: EveActionResultError | undefined,
  output: unknown,
): Error {
  if (error) {
    return errorFromMessage(error.message, error.code);
  }
  const result = new Error("Eve action failed");
  if (output !== undefined) {
    result.cause = output;
  }
  return result;
}

function eventTime(event: {
  readonly meta?: { readonly at: string };
}): number | undefined {
  if (!event.meta?.at) {
    return undefined;
  }
  const timestamp = Date.parse(event.meta.at);
  return Number.isFinite(timestamp) ? timestamp / 1000 : undefined;
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function toolKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`;
}

async function rootSpanIdForSession(sessionId: string): Promise<string> {
  return deterministicEveId("eve:root", sessionId);
}

async function generateEveIds(
  kind: EveEntityKind,
  ...parts: string[]
): Promise<{ rowId: string; spanId: string }> {
  const [rowId, spanId] = await Promise.all([
    deterministicEveId(`eve:row:${kind}`, ...parts),
    deterministicEveId(`eve:${kind}`, ...parts),
  ]);
  return { rowId, spanId };
}

async function spanIdForSubagent(
  sessionId: string,
  callId: string,
): Promise<string> {
  return deterministicEveId("eve:subagent", sessionId, callId);
}

async function deterministicEveId(...parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(
    parts.map((part) => `${part.length}:${part}`).join("\0"),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest, 0, 16));
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
