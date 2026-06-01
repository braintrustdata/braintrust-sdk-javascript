import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers } from "../../isomorph";
import { flush, startSpan, withCurrent } from "../../logger";
import type { Span, StartSpanArgs } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import { flueChannels } from "./flue-channels";
import type {
  FlueBaseEvent,
  FlueCompactionEvent,
  FlueCompactionStartEvent,
  FlueContext,
  FlueEvent,
  FlueObservableContext,
  FlueOperationEvent,
  FlueOperationKind,
  FlueOperationStartEvent,
  FlueRunEndEvent,
  FlueRunStartEvent,
  FlueRuntimeOperationKind,
  FlueTaskEvent,
  FlueTaskStartEvent,
  FlueToolCallEvent,
  FlueToolStartEvent,
  FlueTurnEvent,
  FlueTurnRequestEvent,
} from "../../vendor-sdk-types/flue";

type FlueObserver = (event: unknown, ctx?: unknown) => void;

type FlueAutoState = {
  channel?: ReturnType<typeof flueChannels.createContext.tracingChannel>;
  contexts: WeakSet<object>;
  handlers?: IsoChannelHandlers<
    ChannelMessage<typeof flueChannels.createContext>
  >;
  refCount: number;
};

type SpanState = {
  loggedInput?: boolean;
  metadata: Record<string, unknown>;
  span: Span;
};

const FLUE_AUTO_STATE = Symbol.for("braintrust.flue.auto-state");
const FLUE_OBSERVE_BRIDGE = Symbol.for("braintrust.flue.observe-bridge");

/**
 * Braintrust's Flue observe subscriber.
 *
 * Pass this directly to @flue/runtime/app.observe:
 *
 *   const unsubscribe = observe(braintrustFlueObserver);
 */
export const braintrustFlueObserver: FlueObserver = (event, ctx) => {
  getObserveBridge().handle(event, ctx);
};

export class FluePlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(enableFlueAutoInstrumentation());
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }
}

function enableFlueAutoInstrumentation(): () => void {
  const state = getAutoState();
  state.refCount += 1;

  if (!state.handlers) {
    const channel = flueChannels.createContext.tracingChannel();
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof flueChannels.createContext>
    > = {
      end: (event) => {
        subscribeToFlueContext(event.result, state);
      },
    };

    channel.subscribe(handlers);
    state.channel = channel;
    state.handlers = handlers;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseAutoState(state);
  };
}

function getAutoState(): FlueAutoState {
  const existing = Reflect.get(globalThis, FLUE_AUTO_STATE);
  if (isAutoState(existing)) {
    return existing;
  }
  const state: FlueAutoState = {
    contexts: new WeakSet(),
    refCount: 0,
  };
  Reflect.set(globalThis, FLUE_AUTO_STATE, state);
  return state;
}

function getObserveBridge(): FlueObserveBridge {
  const existing = Reflect.get(globalThis, FLUE_OBSERVE_BRIDGE);
  if (isFlueObserveBridge(existing)) {
    return existing;
  }
  const bridge = new FlueObserveBridge();
  Reflect.set(globalThis, FLUE_OBSERVE_BRIDGE, bridge);
  return bridge;
}

function isFlueObserveBridge(value: unknown): value is FlueObserveBridge {
  return (
    isObjectLike(value) &&
    typeof Reflect.get(value, "handle") === "function" &&
    typeof Reflect.get(value, "reset") === "function"
  );
}

function isAutoState(value: unknown): value is FlueAutoState {
  return (
    isObjectLike(value) &&
    Reflect.get(value, "contexts") instanceof WeakSet &&
    typeof Reflect.get(value, "refCount") === "number"
  );
}

function releaseAutoState(state: FlueAutoState): void {
  state.refCount -= 1;
  if (state.refCount > 0) {
    return;
  }

  try {
    if (state.channel && state.handlers) {
      state.channel.unsubscribe(state.handlers);
    }
  } finally {
    Reflect.deleteProperty(globalThis, FLUE_AUTO_STATE);
  }
}

function subscribeToFlueContext(value: unknown, state: FlueAutoState): void {
  if (!isObservableFlueContext(value) || state.contexts.has(value)) {
    return;
  }

  const ctx = flueContextFromUnknown(value);
  let released = false;
  let unsubscribe: (() => void) | undefined;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      unsubscribe?.();
    } catch (error) {
      logInstrumentationError("Flue context unsubscribe", error);
    }
  };

  try {
    unsubscribe = value.subscribeEvent((event) => {
      if (state.refCount <= 0) {
        release();
        return;
      }

      braintrustFlueObserver(event, ctx);
      if (isAutoContextTerminalEvent(event, ctx)) {
        release();
      }
    });
    state.contexts.add(value);
  } catch (error) {
    logInstrumentationError("Flue context subscription", error);
  }
}

function isAutoContextTerminalEvent(
  event: unknown,
  ctx: FlueContext | undefined,
): boolean {
  if (!isObjectLike(event)) {
    return false;
  }
  const type = Reflect.get(event, "type");
  if (type === "run_end") {
    return true;
  }
  if (type !== "operation") {
    return false;
  }
  return !ctx?.runId && typeof Reflect.get(event, "runId") !== "string";
}

function isObservableFlueContext(
  value: unknown,
): value is FlueObservableContext {
  return (
    isObjectLike(value) &&
    typeof Reflect.get(value, "subscribeEvent") === "function"
  );
}

function isFlueEvent(event: object): event is FlueEvent {
  const type = Reflect.get(event, "type");
  return (
    type === "run_start" ||
    type === "run_end" ||
    type === "operation_start" ||
    type === "operation" ||
    type === "turn_request" ||
    type === "turn" ||
    type === "tool_start" ||
    type === "tool_call" ||
    type === "task_start" ||
    type === "task" ||
    type === "compaction_start" ||
    type === "compaction"
  );
}

function flueContextFromUnknown(ctx: unknown): FlueContext | undefined {
  if (!isObjectLike(ctx)) {
    return undefined;
  }
  const id = Reflect.get(ctx, "id");
  const runId = Reflect.get(ctx, "runId");
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof runId === "string" ? { runId } : {}),
  };
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FlueObserveBridge {
  private compactionsByKey = new Map<string, SpanState>();
  private operationsById = new Map<string, SpanState>();
  private runsById = new Map<string, SpanState>();
  private seenEvents = new WeakSet<object>();
  private tasksById = new Map<string, SpanState>();
  private toolsByKey = new Map<string, SpanState>();
  private turnsByKey = new Map<string, SpanState>();

  handle(event: unknown, ctx: unknown): void {
    if (!isObjectLike(event) || !isFlueEvent(event)) {
      return;
    }
    if (this.seenEvents.has(event)) {
      return;
    }
    this.seenEvents.add(event);

    try {
      this.handleEvent(event, flueContextFromUnknown(ctx));
    } catch (error) {
      logInstrumentationError("Flue observe", error);
    }
  }

  reset(): void {
    this.compactionsByKey.clear();
    this.operationsById.clear();
    this.runsById.clear();
    this.seenEvents = new WeakSet();
    this.tasksById.clear();
    this.toolsByKey.clear();
    this.turnsByKey.clear();
  }

  private handleEvent(event: FlueEvent, ctx: FlueContext | undefined): void {
    switch (event.type) {
      case "run_start":
        this.handleRunStart(event, ctx);
        return;
      case "run_end":
        this.handleRunEnd(event);
        return;
      case "operation_start":
        this.handleOperationStart(event);
        return;
      case "operation":
        this.handleOperation(event);
        return;
      case "turn_request":
        this.handleTurnRequest(event);
        return;
      case "turn":
        this.handleTurn(event);
        return;
      case "tool_start":
        this.handleToolStart(event);
        return;
      case "tool_call":
        this.handleToolCall(event);
        return;
      case "task_start":
        this.handleTaskStart(event);
        return;
      case "task":
        this.handleTask(event);
        return;
      case "compaction_start":
        this.handleCompactionStart(event);
        return;
      case "compaction":
        this.handleCompaction(event);
        return;
      default:
        return;
    }
  }

  private handleRunStart(
    event: FlueRunStartEvent,
    ctx: FlueContext | undefined,
  ): void {
    if (!event.runId) {
      return;
    }

    const workflowName =
      event.workflowName ??
      event.owner?.workflowName ??
      (typeof ctx?.id === "string" ? ctx.id : "unknown");
    const metadata = {
      ...extractPayloadMetadata(event.payload),
      ...extractEventMetadata(event, ctx),
      ...(workflowName ? { "flue.workflow_name": workflowName } : {}),
      provider: "flue",
    };
    const span = startSpan({
      name: `workflow:${workflowName}`,
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event.startedAt ?? event.timestamp),
      event: {
        input: event.payload,
        metadata,
      },
    });

    this.runsById.set(event.runId, { metadata, span });
  }

  private handleRunEnd(event: FlueRunEndEvent): void {
    const state = this.runsById.get(event.runId);
    this.finishPendingSpansForRun(event);

    if (state) {
      safeLog(state.span, {
        ...(event.isError ? { error: errorToString(event.error) } : {}),
        metadata: {
          ...state.metadata,
          ...extractEventMetadata(event),
          ...(event.isError !== undefined
            ? { "flue.is_error": event.isError }
            : {}),
        },
        metrics: durationMetrics(event.durationMs),
        output: event.result,
      });
      safeEnd(state.span, eventTime(event.timestamp));
      this.runsById.delete(event.runId);
    }

    void flush().catch((error) => {
      logInstrumentationError("Flue flush", error);
    });
  }

  private handleOperationStart(event: FlueOperationStartEvent): void {
    if (!event.operationId || !isInstrumentedOperation(event.operationKind)) {
      return;
    }

    const metadata = {
      ...extractEventMetadata(event),
      "flue.operation": event.operationKind,
      provider: "flue",
    };
    const parent = this.parentSpanForEvent(event);
    const span = startFlueSpan(parent, {
      name: `flue.${event.operationKind}`,
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event.timestamp),
      event: { metadata },
    });

    this.operationsById.set(event.operationId, { metadata, span });
  }

  private handleOperation(event: FlueOperationEvent): void {
    if (!isInstrumentedOperation(event.operationKind)) {
      return;
    }

    const state =
      this.operationsById.get(event.operationId) ??
      this.startSyntheticOperation(event);
    const output = operationOutput(event);
    const metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      ...(event.isError !== undefined
        ? { "flue.is_error": event.isError }
        : {}),
      ...(event.usage ? { "flue.usage": event.usage } : {}),
    };

    this.finishPendingChildrenForOperation(event, output);
    safeLog(state.span, {
      ...(event.isError ? { error: errorToString(event.error) } : {}),
      metadata,
      metrics: durationMetrics(event.durationMs),
      output,
    });
    safeEnd(state.span, eventTime(event.timestamp));
    this.operationsById.delete(event.operationId);
  }

  private handleTurnRequest(event: FlueTurnRequestEvent): void {
    const key = turnKey(event);
    if (!key) {
      return;
    }

    const metadata = {
      ...extractEventMetadata(event),
      ...(event.api ? { "flue.api": event.api } : {}),
      ...(event.model ? { model: event.model, "flue.model": event.model } : {}),
      ...(event.provider ? { provider: event.provider } : { provider: "flue" }),
      ...(event.provider ? { "flue.provider": event.provider } : {}),
      ...(event.purpose ? { "flue.turn_purpose": event.purpose } : {}),
      ...(event.reasoning ? { reasoning: event.reasoning } : {}),
      ...(event.input?.systemPrompt
        ? { "flue.system_prompt": event.input.systemPrompt }
        : {}),
      ...(event.input?.tools ? { tools: event.input.tools } : {}),
    };
    const parent = this.parentSpanForTurn(event);
    const span = startFlueSpan(parent, {
      name: `llm:${event.model ?? event.purpose ?? "unknown"}`,
      spanAttributes: { type: SpanTypeAttribute.LLM },
      startTime: eventTime(event.timestamp),
      event: {
        input: event.input?.messages,
        metadata,
      },
    });

    this.logOperationInput(
      event.operationId,
      event.input?.messages ?? event.input,
    );
    this.turnsByKey.set(key, { metadata, span });
  }

  private handleTurn(event: FlueTurnEvent): void {
    const key = turnKey(event);
    if (!key) {
      return;
    }

    const state = this.turnsByKey.get(key) ?? this.startSyntheticTurn(event);
    const metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      ...(event.api ? { "flue.api": event.api } : {}),
      ...(event.model ? { model: event.model, "flue.model": event.model } : {}),
      ...(event.provider ? { provider: event.provider } : {}),
      ...(event.provider ? { "flue.provider": event.provider } : {}),
      ...(event.purpose ? { "flue.turn_purpose": event.purpose } : {}),
      ...(event.stopReason ? { "flue.stop_reason": event.stopReason } : {}),
      ...(event.isError !== undefined
        ? { "flue.is_error": event.isError }
        : {}),
    };

    safeLog(state.span, {
      ...(event.isError ? { error: errorToString(event.error) } : {}),
      metadata,
      metrics: {
        ...durationMetrics(event.durationMs),
        ...metricsFromUsage(event.usage),
      },
      output: event.output,
    });
    safeEnd(state.span, eventTime(event.timestamp));
    this.turnsByKey.delete(key);
  }

  private handleToolStart(event: FlueToolStartEvent): void {
    if (!event.toolCallId) {
      return;
    }

    const metadata = {
      ...extractEventMetadata(event),
      ...(event.toolName ? { "flue.tool_name": event.toolName } : {}),
      "flue.tool_call_id": event.toolCallId,
      provider: "flue",
    };
    const parent = this.parentSpanForTool(event);
    const span = startFlueSpan(parent, {
      name: `tool:${event.toolName ?? "unknown"}`,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      startTime: eventTime(event.timestamp),
      event: {
        input: event.args,
        metadata,
      },
    });

    this.toolsByKey.set(toolKey(event), { metadata, span });
  }

  private handleToolCall(event: FlueToolCallEvent): void {
    if (!event.toolCallId) {
      return;
    }

    const key = toolKey(event);
    const state = this.toolsByKey.get(key) ?? this.startSyntheticTool(event);
    const metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      ...(event.toolName ? { "flue.tool_name": event.toolName } : {}),
      "flue.tool_call_id": event.toolCallId,
      ...(event.isError !== undefined
        ? { "flue.is_error": event.isError }
        : {}),
    };

    safeLog(state.span, {
      ...(event.isError ? { error: errorToString(event.result) } : {}),
      metadata,
      metrics: durationMetrics(event.durationMs),
      output: event.result,
    });
    safeEnd(state.span, eventTime(event.timestamp));
    this.toolsByKey.delete(key);
  }

  private handleTaskStart(event: FlueTaskStartEvent): void {
    if (!event.taskId) {
      return;
    }

    const metadata = {
      ...extractEventMetadata(event),
      ...(event.agent ? { "flue.agent": event.agent } : {}),
      ...(event.cwd ? { "flue.cwd": event.cwd } : {}),
      "flue.task_id": event.taskId,
      provider: "flue",
    };
    const parent = this.parentSpanForEvent(event);
    const span = startFlueSpan(parent, {
      name: event.agent ? `task:${event.agent}` : "flue.task",
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event.timestamp),
      event: {
        input: event.prompt,
        metadata,
      },
    });

    this.tasksById.set(event.taskId, { metadata, span });
  }

  private handleTask(event: FlueTaskEvent): void {
    const state = this.tasksById.get(event.taskId);
    if (!state) {
      return;
    }

    safeLog(state.span, {
      ...(event.isError ? { error: errorToString(event.result) } : {}),
      metadata: {
        ...state.metadata,
        ...extractEventMetadata(event),
        ...(event.agent ? { "flue.agent": event.agent } : {}),
        ...(event.isError !== undefined
          ? { "flue.is_error": event.isError }
          : {}),
      },
      metrics: durationMetrics(event.durationMs),
      output: event.result,
    });
    safeEnd(state.span, eventTime(event.timestamp));
    this.tasksById.delete(event.taskId);
  }

  private handleCompactionStart(event: FlueCompactionStartEvent): void {
    const key = compactionKey(event);
    const input = {
      ...(event.estimatedTokens !== undefined
        ? { estimatedTokens: event.estimatedTokens }
        : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    };
    const metadata = {
      ...extractEventMetadata(event),
      ...(event.reason ? { "flue.compaction_reason": event.reason } : {}),
      provider: "flue",
    };
    const parent = this.parentSpanForEvent(event);
    const span = startFlueSpan(parent, {
      name: `compaction:${event.reason ?? "unknown"}`,
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event.timestamp),
      event: {
        input,
        metadata,
      },
    });

    this.logOperationInput(event.operationId, input);
    this.compactionsByKey.set(key, { metadata, span });
  }

  private handleCompaction(event: FlueCompactionEvent): void {
    const key = compactionKey(event);
    const state =
      this.compactionsByKey.get(key) ?? this.startSyntheticCompaction(event);
    const metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      ...(event.usage ? { "flue.usage": event.usage } : {}),
    };

    safeLog(state.span, {
      metadata,
      metrics: {
        ...durationMetrics(event.durationMs),
        ...(typeof event.messagesBefore === "number"
          ? { messages_before: event.messagesBefore }
          : {}),
        ...(typeof event.messagesAfter === "number"
          ? { messages_after: event.messagesAfter }
          : {}),
      },
      output: {
        messagesAfter: event.messagesAfter,
        messagesBefore: event.messagesBefore,
      },
    });
    safeEnd(state.span, eventTime(event.timestamp));
    this.compactionsByKey.delete(key);
  }

  private parentSpanForTurn(event: FlueTurnRequestEvent): Span | undefined {
    if (
      event.purpose === "compaction" ||
      event.purpose === "compaction_prefix"
    ) {
      const compaction = this.compactionsByKey.get(compactionKey(event));
      if (compaction) {
        return compaction.span;
      }
    }
    return this.parentSpanForEvent(event);
  }

  private parentSpanForEvent(event: FlueBaseEvent): Span | undefined {
    const turn = turnKey(event);
    if (turn) {
      const turnState = this.turnsByKey.get(turn);
      if (turnState) {
        return turnState.span;
      }
    }
    if (event.taskId) {
      const task = this.tasksById.get(event.taskId);
      if (task) {
        return task.span;
      }
    }
    if (event.operationId) {
      const operation = this.operationsById.get(event.operationId);
      if (operation) {
        return operation.span;
      }
    }
    if (event.runId) {
      return this.runsById.get(event.runId)?.span;
    }
    return undefined;
  }

  private parentSpanForTool(event: FlueBaseEvent): Span | undefined {
    if (event.taskId) {
      const task = this.tasksById.get(event.taskId);
      if (task) {
        return task.span;
      }
    }
    if (event.operationId) {
      const operation = this.operationsById.get(event.operationId);
      if (operation) {
        return operation.span;
      }
    }
    if (event.runId) {
      return this.runsById.get(event.runId)?.span;
    }
    return undefined;
  }

  private logOperationInput(
    operationId: string | undefined,
    input: unknown,
  ): void {
    if (!operationId || input === undefined) {
      return;
    }
    const operation = this.operationsById.get(operationId);
    if (!operation || operation.loggedInput) {
      return;
    }
    safeLog(operation.span, { input });
    operation.loggedInput = true;
  }

  private startSyntheticOperation(event: FlueOperationEvent): SpanState {
    const metadata = {
      ...extractEventMetadata(event),
      "flue.operation": event.operationKind,
      provider: "flue",
    };
    const span = startFlueSpan(this.parentSpanForEvent(event), {
      name: `flue.${event.operationKind}`,
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event.timestamp),
      event: { metadata },
    });
    return { metadata, span };
  }

  private startSyntheticTurn(event: FlueTurnEvent): SpanState {
    const metadata = {
      ...extractEventMetadata(event),
      ...(event.api ? { "flue.api": event.api } : {}),
      ...(event.model ? { model: event.model, "flue.model": event.model } : {}),
      ...(event.provider ? { provider: event.provider } : { provider: "flue" }),
      ...(event.provider ? { "flue.provider": event.provider } : {}),
      ...(event.purpose ? { "flue.turn_purpose": event.purpose } : {}),
    };
    const span = startFlueSpan(this.parentSpanForEvent(event), {
      name: `llm:${event.model ?? event.purpose ?? "unknown"}`,
      spanAttributes: { type: SpanTypeAttribute.LLM },
      startTime: eventTime(event.timestamp),
      event: { metadata },
    });
    return { metadata, span };
  }

  private startSyntheticTool(event: FlueToolCallEvent): SpanState {
    const metadata = {
      ...extractEventMetadata(event),
      ...(event.toolName ? { "flue.tool_name": event.toolName } : {}),
      "flue.tool_call_id": event.toolCallId,
      provider: "flue",
    };
    const span = startFlueSpan(this.parentSpanForTool(event), {
      name: `tool:${event.toolName ?? "unknown"}`,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      startTime: eventTime(event.timestamp),
      event: { metadata },
    });
    return { metadata, span };
  }

  private startSyntheticCompaction(event: FlueCompactionEvent): SpanState {
    const metadata = {
      ...extractEventMetadata(event),
      provider: "flue",
    };
    const span = startFlueSpan(this.parentSpanForEvent(event), {
      name: "compaction:unknown",
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event.timestamp),
      event: { metadata },
    });
    return { metadata, span };
  }

  private finishPendingChildrenForOperation(
    event: FlueOperationEvent,
    operationOutput: unknown,
  ): void {
    const endTime = eventTime(event.timestamp);
    const usage = event.usage ?? usageFromOperationResult(event.result);
    const turnEntries = [...this.turnsByKey].filter(([, state]) =>
      stateMatchesOperation(state, event.operationId),
    );

    turnEntries.forEach(([key, state], index) => {
      const shouldLogOperationOutput =
        (event.operationKind === "prompt" || event.operationKind === "skill") &&
        index === turnEntries.length - 1 &&
        operationOutput !== undefined;
      safeLog(state.span, {
        metadata: state.metadata,
        metrics: metricsFromUsage(usage),
        ...(shouldLogOperationOutput ? { output: operationOutput } : {}),
      });
      safeEnd(state.span, endTime);
      this.turnsByKey.delete(key);
    });

    for (const [key, state] of this.toolsByKey) {
      if (!stateMatchesOperation(state, event.operationId)) {
        continue;
      }
      safeEnd(state.span, endTime);
      this.toolsByKey.delete(key);
    }

    for (const [key, state] of this.tasksById) {
      if (!stateMatchesOperation(state, event.operationId)) {
        continue;
      }
      safeEnd(state.span, endTime);
      this.tasksById.delete(key);
    }

    for (const [key, state] of this.compactionsByKey) {
      if (!stateMatchesOperation(state, event.operationId)) {
        continue;
      }
      safeLog(state.span, {
        metadata: state.metadata,
        metrics: durationMetrics(event.durationMs),
        output: { completed: true },
      });
      safeEnd(state.span, eventTime(event.timestamp));
      this.compactionsByKey.delete(key);
    }
  }

  private finishPendingSpansForRun(event: FlueRunEndEvent): void {
    const endTime = eventTime(event.timestamp);

    for (const [key, state] of this.toolsByKey) {
      if (!stateMatchesRun(state, event.runId)) {
        continue;
      }
      safeEnd(state.span, endTime);
      this.toolsByKey.delete(key);
    }

    for (const [key, state] of this.turnsByKey) {
      if (!stateMatchesRun(state, event.runId)) {
        continue;
      }
      safeEnd(state.span, endTime);
      this.turnsByKey.delete(key);
    }

    for (const [key, state] of this.tasksById) {
      if (!stateMatchesRun(state, event.runId)) {
        continue;
      }
      safeEnd(state.span, endTime);
      this.tasksById.delete(key);
    }

    for (const [key, state] of this.compactionsByKey) {
      if (!stateMatchesRun(state, event.runId)) {
        continue;
      }
      safeLog(state.span, {
        metadata: state.metadata,
        output: { completed: true },
      });
      safeEnd(state.span, endTime);
      this.compactionsByKey.delete(key);
    }

    for (const [key, state] of this.operationsById) {
      if (!stateMatchesRun(state, event.runId)) {
        continue;
      }
      safeLog(state.span, {
        metadata: state.metadata,
        ...(state.metadata["flue.operation"] === "compact"
          ? { output: { completed: true } }
          : {}),
      });
      safeEnd(state.span, endTime);
      this.operationsById.delete(key);
    }
  }
}

function isInstrumentedOperation(
  operation: FlueRuntimeOperationKind,
): operation is Exclude<FlueOperationKind, "task"> {
  return (
    operation === "prompt" || operation === "skill" || operation === "compact"
  );
}

function extractEventMetadata(
  event: FlueBaseEvent,
  ctx?: FlueContext,
): Record<string, unknown> {
  return {
    ...(event.runId ? { "flue.run_id": event.runId } : {}),
    ...(event.instanceId ? { "flue.instance_id": event.instanceId } : {}),
    ...(event.dispatchId ? { "flue.dispatch_id": event.dispatchId } : {}),
    ...(typeof event.eventIndex === "number"
      ? { "flue.event_index": event.eventIndex }
      : {}),
    ...(event.session ? { "flue.session": event.session } : {}),
    ...(event.parentSession
      ? { "flue.parent_session": event.parentSession }
      : {}),
    ...(event.harness ? { "flue.harness": event.harness } : {}),
    ...(event.taskId ? { "flue.task_id": event.taskId } : {}),
    ...(event.operationId ? { "flue.operation_id": event.operationId } : {}),
    ...(event.turnId ? { "flue.turn_id": event.turnId } : {}),
    ...(typeof ctx?.id === "string" ? { "flue.context_id": ctx.id } : {}),
    ...(typeof ctx?.runId === "string"
      ? { "flue.context_run_id": ctx.runId }
      : {}),
  };
}

function extractPayloadMetadata(payload: unknown): Record<string, unknown> {
  if (!isObjectLike(payload)) {
    return {};
  }
  const metadata = Reflect.get(payload, "metadata");
  if (!isObjectLike(metadata)) {
    return {};
  }
  return Object.fromEntries(Object.entries(metadata));
}

function operationOutput(event: FlueOperationEvent): unknown {
  if (event.operationKind === "prompt" || event.operationKind === "skill") {
    return llmResultFromOperationResult(event.result);
  }
  return (
    event.result ??
    (event.operationKind === "compact" ? { completed: true } : undefined)
  );
}

function llmResultFromOperationResult(result: unknown): unknown {
  if (!isObjectLike(result)) {
    return result;
  }
  const text = Reflect.get(result, "text");
  return text === undefined ? result : text;
}

function usageFromOperationResult(result: unknown): unknown {
  if (!isObjectLike(result)) {
    return undefined;
  }
  return Reflect.get(result, "usage");
}

function metricsFromUsage(usage: unknown): Record<string, number> {
  if (!isObjectLike(usage)) {
    return {};
  }
  const cacheRead = Reflect.get(usage, "cacheRead");
  const cacheWrite = Reflect.get(usage, "cacheWrite");
  const cost = Reflect.get(usage, "cost");
  const input = Reflect.get(usage, "input");
  const output = Reflect.get(usage, "output");
  const totalTokens = Reflect.get(usage, "totalTokens");
  const totalCost = isObjectLike(cost) ? Reflect.get(cost, "total") : undefined;

  return {
    ...(typeof input === "number" ? { prompt_tokens: input } : {}),
    ...(typeof output === "number" ? { completion_tokens: output } : {}),
    ...(typeof cacheRead === "number"
      ? { prompt_cached_tokens: cacheRead }
      : {}),
    ...(typeof cacheWrite === "number"
      ? { prompt_cache_creation_tokens: cacheWrite }
      : {}),
    ...(typeof totalTokens === "number" ? { tokens: totalTokens } : {}),
    ...(typeof totalCost === "number" ? { estimated_cost: totalCost } : {}),
  };
}

function durationMetrics(durationMs: unknown): Record<string, number> {
  return typeof durationMs === "number" ? { duration_ms: durationMs } : {};
}

function eventTime(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp / 1000 : undefined;
}

function turnKey(event: FlueBaseEvent): string | undefined {
  return event.turnId;
}

function toolKey(event: FlueBaseEvent & { toolCallId?: string }): string {
  return `${event.turnId ?? event.operationId ?? event.taskId ?? event.runId ?? "unknown"}:${event.toolCallId ?? "unknown"}`;
}

function compactionKey(event: FlueBaseEvent): string {
  return [
    event.instanceId ?? "",
    event.runId ?? "",
    event.session ?? "",
    event.operationId ?? "",
    event.taskId ?? "",
  ].join(":");
}

function stateMatchesOperation(state: SpanState, operationId: string): boolean {
  return state.metadata["flue.operation_id"] === operationId;
}

function stateMatchesRun(state: SpanState, runId: string): boolean {
  return state.metadata["flue.run_id"] === runId;
}

function startFlueSpan(parent: Span | undefined, args: StartSpanArgs): Span {
  return parent ? withCurrent(parent, () => startSpan(args)) : startSpan(args);
}

function safeLog(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    logInstrumentationError("Flue span log", error);
  }
}

function safeEnd(span: Span, endTime: number | undefined): void {
  try {
    span.end(endTime === undefined ? undefined : { endTime });
  } catch (error) {
    logInstrumentationError("Flue span end", error);
  }
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logInstrumentationError(label: string, error: unknown): void {
  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.error(`Error in ${label} instrumentation:`, error);
}
