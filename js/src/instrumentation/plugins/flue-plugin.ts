import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers } from "../../isomorph";
import {
  _internalGetGlobalState,
  BRAINTRUST_CURRENT_SPAN_STORE,
  startSpan,
  withCurrent,
} from "../../logger";
import type { CurrentSpanStore, Span } from "../../logger";
import { getCurrentUnixTimestamp, isObject } from "../../util";
import { SpanTypeAttribute } from "../../../util/index";
import {
  patchFlueSessionInPlace,
  subscribeFlueContextEvents,
  wrapFlueContext,
  wrapFlueHarness,
} from "../../wrappers/flue";
import { flueChannels } from "./flue-channels";
import type {
  FlueBaseEvent,
  FlueCallOptions,
  FlueCompactionEvent,
  FlueCompactionStartEvent,
  FlueEvent,
  FlueOperationEvent,
  FlueOperationKind,
  FlueOperationStartEvent,
  FluePromptResponse,
  FlueSession,
  FlueSkillOptions,
  FlueTaskEvent,
  FlueTaskOptions,
  FlueTaskStartEvent,
  FlueThinkingDeltaEvent,
  FlueThinkingEndEvent,
  FlueToolCallEvent,
  FlueToolStartEvent,
  FlueTurnEvent,
  FlueUsage,
} from "../../vendor-sdk-types/flue";

type OperationState = {
  metadata: Record<string, unknown>;
  operation: FlueOperationKind;
  operationId?: string;
  sessionName?: string;
  span: Span;
  startTime: number;
};

type SpanState = {
  metadata: Record<string, unknown>;
  operationState?: OperationState;
  span: Span;
  startTime: number;
};

type TurnState = SpanState & {
  finalThinking?: string;
  hasThinking: boolean;
  text: string[];
  thinking: string[];
  toolCalls: Array<{
    args?: unknown;
    toolCallId?: string;
    toolName?: string;
  }>;
};

export class FluePlugin extends BasePlugin {
  private activeOperationsById = new Map<string, OperationState>();
  private activeOperationsByScope = new Map<string, OperationState[]>();
  private compactionsByScope = new Map<string, SpanState>();
  private pendingOperationsByKey = new Map<string, OperationState[]>();
  private tasksById = new Map<string, SpanState>();
  private toolsById = new Map<string, SpanState>();
  private turnsByScope = new Map<string, TurnState>();

  protected onEnable(): void {
    this.subscribeToContextCreation();
    this.subscribeToSessionCreation();
    this.subscribeToContextEvents();
    this.subscribeToSessionOperations();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.activeOperationsById.clear();
    this.activeOperationsByScope.clear();
    this.compactionsByScope.clear();
    this.pendingOperationsByKey.clear();
    this.tasksById.clear();
    this.toolsById.clear();
    this.turnsByScope.clear();
  }

  private subscribeToContextCreation(): void {
    const channel = flueChannels.createContext.tracingChannel();
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof flueChannels.createContext>
    > = {
      end: (event) => {
        const ctx = event.result;
        if (!ctx) {
          return;
        }
        subscribeFlueContextEvents(ctx);
        wrapFlueContext(ctx);
      },
      error: () => {},
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }

  private subscribeToSessionCreation(): void {
    const channel = flueChannels.openSession.tracingChannel();
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof flueChannels.openSession>
    > = {
      asyncEnd: (event) => {
        if (event.result) {
          patchFlueSessionInPlace(
            event.result as FlueSession & Record<PropertyKey, unknown>,
          );
        }
        if (event.harness) {
          wrapFlueHarness(event.harness);
        }
      },
      error: () => {},
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }

  private subscribeToSessionOperations(): void {
    this.subscribeToSessionOperation(flueChannels.prompt);
    this.subscribeToSessionOperation(flueChannels.skill);
    this.subscribeToSessionOperation(flueChannels.task);
    this.subscribeToCompact();
  }

  private subscribeToSessionOperation(
    channel:
      | typeof flueChannels.prompt
      | typeof flueChannels.skill
      | typeof flueChannels.task,
  ): void {
    const tracingChannel = channel.tracingChannel();
    const states = new WeakMap<object, OperationState>();
    const ensureState = (
      event: ChannelMessage<typeof channel>,
    ): OperationState => {
      const existing = states.get(event);
      if (existing) {
        return existing;
      }
      const state = this.startOperationState({
        args: event.arguments,
        moduleVersion:
          typeof event.moduleVersion === "string"
            ? event.moduleVersion
            : undefined,
        operation: event.operation,
        session: event.session,
      });
      states.set(event, state);
      return state;
    };
    const unbindCurrentSpanStore = this.bindCurrentSpanStoreToOperationStart(
      tracingChannel,
      ensureState,
    );
    const handlers: IsoChannelHandlers<ChannelMessage<typeof channel>> = {
      start: (event) => {
        ensureState(event);
      },
      asyncEnd: (event) => {
        this.endOperationState(states.get(event), event.result);
        states.delete(event);
      },
      error: (event) => {
        const state = states.get(event);
        if (state && event.error) {
          safeLog(state.span, { error: errorToString(event.error) });
          this.finishOperationState(state);
        }
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToCompact(): void {
    const tracingChannel = flueChannels.compact.tracingChannel();
    const states = new WeakMap<object, OperationState>();
    const ensureState = (
      event: ChannelMessage<typeof flueChannels.compact>,
    ): OperationState => {
      const existing = states.get(event);
      if (existing) {
        return existing;
      }
      const state = this.startOperationState({
        args: [],
        moduleVersion:
          typeof event.moduleVersion === "string"
            ? event.moduleVersion
            : undefined,
        operation: event.operation,
        session: event.session,
      });
      states.set(event, state);
      return state;
    };
    const unbindCurrentSpanStore = this.bindCurrentSpanStoreToOperationStart(
      tracingChannel,
      ensureState,
    );
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof flueChannels.compact>
    > = {
      start: (event) => {
        ensureState(event);
      },
      asyncEnd: (event) => {
        this.endOperationState(states.get(event), undefined);
        states.delete(event);
      },
      error: (event) => {
        const state = states.get(event);
        if (state && event.error) {
          safeLog(state.span, { error: errorToString(event.error) });
          this.finishOperationState(state);
        }
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToContextEvents(): void {
    const channel = flueChannels.contextEvent.tracingChannel();
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof flueChannels.contextEvent>
    > = {
      start: (event) => {
        const flueEvent = event.arguments[0];
        if (!flueEvent) {
          return;
        }

        try {
          this.handleFlueEvent(flueEvent);
        } catch (error) {
          logInstrumentationError("Flue event", error);
        }
      },
      error: () => {},
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }

  private bindCurrentSpanStoreToOperationStart<TEvent extends object>(
    tracingChannel: {
      start?: {
        bindStore<T>(
          store: CurrentSpanStore,
          transform: (event: TEvent) => T,
        ): void;
        unbindStore(store: CurrentSpanStore): boolean;
      };
    },
    ensureState: (event: TEvent) => OperationState,
  ): (() => void) | undefined {
    const state = _internalGetGlobalState();
    const startChannel = tracingChannel.start;
    const contextManager = state?.contextManager;
    const currentSpanStore = contextManager
      ? (
          contextManager as {
            [BRAINTRUST_CURRENT_SPAN_STORE]?: CurrentSpanStore;
          }
        )[BRAINTRUST_CURRENT_SPAN_STORE]
      : undefined;

    if (!currentSpanStore || !startChannel) {
      return undefined;
    }

    startChannel.bindStore(currentSpanStore, (event: TEvent) => {
      const operationState = ensureState(event);
      return contextManager!.wrapSpanForStore(operationState.span);
    });

    return () => {
      startChannel.unbindStore(currentSpanStore);
    };
  }

  private startOperationState(args: {
    args: ArrayLike<unknown>;
    moduleVersion?: string;
    operation: FlueOperationKind;
    session?: FlueSession;
  }): OperationState {
    const sessionName = getSessionName(args.session);
    const metadata = {
      ...extractOperationInputMetadata(args.operation, args.args),
      ...extractSessionMetadata(args.session),
      "flue.operation": args.operation,
      provider: "flue",
      ...(args.moduleVersion ? { "flue.version": args.moduleVersion } : {}),
    };
    const span = startSpan({
      name: `flue.session.${args.operation}`,
      spanAttributes: { type: SpanTypeAttribute.TASK },
    });
    const state: OperationState = {
      metadata,
      operation: args.operation,
      sessionName,
      span,
      startTime: getCurrentUnixTimestamp(),
    };

    safeLog(span, {
      input: extractOperationInput(args.operation, args.args),
      metadata,
    });

    this.pendingOperationQueue(operationKey(sessionName, args.operation)).push(
      state,
    );
    addOperationToScope(
      this.activeOperationsByScope,
      sessionName ?? "unknown",
      state,
    );

    return state;
  }

  private endOperationState(
    state: OperationState | undefined,
    result: FluePromptResponse | undefined,
  ): void {
    if (!state) {
      return;
    }

    const metadata = {
      ...state.metadata,
      ...extractPromptResponseMetadata(result),
    };
    const metrics = {
      ...buildDurationMetrics(state.startTime),
      ...metricsFromUsage(result?.usage),
    };

    safeLog(state.span, {
      metadata,
      metrics,
      output: extractOperationOutput(result),
    });
    if (state.operation === "compact") {
      this.finishCompactionsForOperation(state);
    }
    this.finishOperationState(state);
  }

  private finishOperationState(state: OperationState): void {
    removePendingOperation(this.pendingOperationsByKey, state);
    if (state.operationId) {
      this.activeOperationsById.delete(state.operationId);
    }
    removeScopedOperation(this.activeOperationsByScope, state);
    state.span.end();
  }

  private handleFlueEvent(event: FlueEvent): void {
    switch (event.type) {
      case "operation_start":
        this.handleOperationStart(event as FlueOperationStartEvent);
        return;
      case "operation":
        this.handleOperation(event as FlueOperationEvent);
        return;
      case "text_delta":
        this.ensureTurnState(event).text.push(
          typeof event.text === "string" ? event.text : "",
        );
        return;
      case "thinking_start":
        this.handleThinkingStart(event);
        return;
      case "thinking_delta":
        this.handleThinkingDelta(event as FlueThinkingDeltaEvent);
        return;
      case "thinking_end":
        this.handleThinkingEnd(event as FlueThinkingEndEvent);
        return;
      case "turn":
        this.handleTurn(event as FlueTurnEvent);
        return;
      case "tool_start":
        this.handleToolStart(event as FlueToolStartEvent);
        return;
      case "tool_call":
        this.handleToolCall(event as FlueToolCallEvent);
        return;
      case "task_start":
        this.handleTaskStart(event as FlueTaskStartEvent);
        return;
      case "task":
        this.handleTask(event as FlueTaskEvent);
        return;
      case "compaction_start":
        this.handleCompactionStart(event as FlueCompactionStartEvent);
        return;
      case "compaction":
        this.handleCompaction(event as FlueCompactionEvent);
        return;
      default:
        return;
    }
  }

  private handleOperationStart(event: FlueOperationStartEvent): void {
    if (!isInstrumentedOperation(event.operationKind)) {
      return;
    }

    const state = this.takePendingOperationForEvent(event);
    if (!state) {
      return;
    }

    state.operationId = event.operationId;
    this.activeOperationsById.set(event.operationId, state);
    addScopedOperation(this.activeOperationsByScope, event, state);
    state.metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      "flue.operation_id": event.operationId,
    };
    safeLog(state.span, { metadata: state.metadata });
  }

  private handleOperation(event: FlueOperationEvent): void {
    const state = event.operationId
      ? this.activeOperationsById.get(event.operationId)
      : undefined;
    if (!state) {
      return;
    }

    const metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      ...(typeof event.durationMs === "number"
        ? { "flue.duration_ms": event.durationMs }
        : {}),
      ...(event.isError !== undefined
        ? { "flue.is_error": event.isError }
        : {}),
    };
    const metrics = metricsFromUsage(event.usage);

    safeLog(state.span, {
      ...(event.error ? { error: errorToString(event.error) } : {}),
      metadata,
      ...(Object.keys(metrics).length ? { metrics } : {}),
    });
  }

  private ensureTurnState(event: FlueBaseEvent): TurnState {
    const scope = scopeKey(event);
    const existing = this.turnsByScope.get(scope);
    if (existing) {
      return existing;
    }

    const parent = this.parentSpanForEvent(event);
    const metadata = {
      ...extractEventMetadata(event),
      provider: "flue",
    };
    const span = startFlueSpan(parent, {
      name: "flue.turn",
      spanAttributes: { type: SpanTypeAttribute.LLM },
    });
    const state: TurnState = {
      metadata,
      span,
      hasThinking: false,
      startTime: getCurrentUnixTimestamp(),
      text: [],
      thinking: [],
      toolCalls: [],
    };
    safeLog(span, { metadata });
    this.turnsByScope.set(scope, state);
    return state;
  }

  private handleTurn(event: FlueTurnEvent): void {
    const scope = scopeKey(event);
    const state = this.ensureTurnState(event);
    const text = state.text.join("");
    const reasoning = state.finalThinking ?? state.thinking.join("");
    const outputReasoning =
      reasoning ||
      (state.hasThinking
        ? "[reasoning stream present; content unavailable]"
        : undefined);
    const metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      ...(event.model ? { model: event.model, "flue.model": event.model } : {}),
      ...(event.stopReason ? { "flue.stop_reason": event.stopReason } : {}),
      ...(event.isError !== undefined
        ? { "flue.is_error": event.isError }
        : {}),
      provider: "flue",
    };

    safeLog(state.span, {
      ...(event.error ? { error: errorToString(event.error) } : {}),
      metadata,
      metrics: {
        ...durationMsMetrics(event.durationMs),
        ...metricsFromUsage(event.usage),
      },
      output: toAssistantOutput(
        text,
        event.stopReason,
        outputReasoning,
        state.toolCalls,
      ),
    });
    state.span.end();
    this.turnsByScope.delete(scope);
  }

  private handleThinkingDelta(event: FlueThinkingDeltaEvent): void {
    const delta = event.delta;
    if (typeof delta !== "string" || !delta) {
      return;
    }
    const state = this.ensureTurnState(event);
    state.hasThinking = true;
    state.metadata["flue.thinking"] = true;
    state.thinking.push(delta);
  }

  private handleThinkingStart(event: FlueBaseEvent): void {
    const state = this.ensureTurnState(event);
    state.hasThinking = true;
    state.metadata["flue.thinking"] = true;
  }

  private handleThinkingEnd(event: FlueThinkingEndEvent): void {
    const state = this.ensureTurnState(event);
    state.hasThinking = true;
    state.metadata["flue.thinking"] = true;
    if (typeof event.content === "string" && event.content) {
      state.finalThinking = event.content;
    }
  }

  private handleToolStart(event: FlueToolStartEvent): void {
    const toolCallId = event.toolCallId;
    if (!toolCallId) {
      return;
    }

    const parent = this.parentSpanForEvent(event);
    const scope = scopeKey(event);
    let turnState = this.turnsByScope.get(scope);
    if (!turnState && parent) {
      turnState = this.ensureTurnState(event);
    }
    const metadata = {
      ...extractEventMetadata(event),
      ...(event.toolName ? { "flue.tool_name": event.toolName } : {}),
      "flue.tool_call_id": toolCallId,
      provider: "flue",
    };
    const span = startFlueSpan(parent, {
      name: `tool: ${event.toolName ?? "unknown"}`,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    });
    if (turnState) {
      turnState.toolCalls.push({
        args: event.args,
        toolCallId,
        toolName: event.toolName,
      });
    }
    safeLog(span, {
      input: event.args,
      metadata,
    });
    this.toolsById.set(toolKey(event), {
      metadata,
      span,
      startTime: getCurrentUnixTimestamp(),
    });
  }

  private handleToolCall(event: FlueToolCallEvent): void {
    const key = toolKey(event);
    const state =
      this.toolsById.get(key) ??
      this.startSyntheticToolState(event, event.toolName ?? "unknown");
    const metadata = {
      ...state.metadata,
      ...extractEventMetadata(event),
      ...(event.toolName ? { "flue.tool_name": event.toolName } : {}),
      ...(event.toolCallId ? { "flue.tool_call_id": event.toolCallId } : {}),
      ...(event.isError !== undefined
        ? { "flue.is_error": event.isError }
        : {}),
    };

    safeLog(state.span, {
      ...(event.isError ? { error: errorToString(event.result) } : {}),
      metadata,
      metrics: durationMsMetrics(event.durationMs),
      output: event.result,
    });
    state.span.end();
    this.toolsById.delete(key);
  }

  private handleTaskStart(event: FlueTaskStartEvent): void {
    const parent = this.parentSpanForEvent(event);
    const metadata = {
      ...extractEventMetadata(event),
      ...(event.role ? { "flue.role": event.role } : {}),
      ...(event.cwd ? { "flue.cwd": event.cwd } : {}),
      "flue.task_id": event.taskId,
      provider: "flue",
    };
    const span = startFlueSpan(parent, {
      name: "flue.task",
      spanAttributes: { type: SpanTypeAttribute.TASK },
    });
    safeLog(span, {
      input: event.prompt,
      metadata,
    });
    this.tasksById.set(event.taskId, {
      metadata,
      span,
      startTime: getCurrentUnixTimestamp(),
    });
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
        ...(event.isError !== undefined
          ? { "flue.is_error": event.isError }
          : {}),
      },
      metrics: durationMsMetrics(event.durationMs),
      output: event.result,
    });
    state.span.end();
    this.tasksById.delete(event.taskId);
  }

  private handleCompactionStart(event: FlueCompactionStartEvent): void {
    const operationState = this.operationStateForEvent(event);
    const parent = operationState?.span ?? this.parentSpanForEvent(event);
    const metadata = {
      ...extractEventMetadata(event),
      ...(event.reason ? { "flue.compaction_reason": event.reason } : {}),
      provider: "flue",
    };
    const span = startFlueSpan(parent, {
      name: "flue.compaction",
      spanAttributes: { type: SpanTypeAttribute.TASK },
    });
    safeLog(span, {
      input: {
        estimatedTokens: event.estimatedTokens,
        reason: event.reason,
      },
      metadata,
    });
    this.compactionsByScope.set(scopeKey(event), {
      metadata,
      operationState,
      span,
      startTime: getCurrentUnixTimestamp(),
    });
  }

  private handleCompaction(event: FlueCompactionEvent): void {
    const key = scopeKey(event);
    const state =
      this.compactionsByScope.get(key) ?? this.findCompactionState(event);
    if (!state) {
      return;
    }

    safeLog(state.span, {
      metadata: {
        ...state.metadata,
        ...extractEventMetadata(event),
        ...(typeof event.messagesBefore === "number"
          ? { "flue.messages_before": event.messagesBefore }
          : {}),
        ...(typeof event.messagesAfter === "number"
          ? { "flue.messages_after": event.messagesAfter }
          : {}),
      },
      metrics: {
        ...durationMsMetrics(event.durationMs),
        ...metricsFromUsage(event.usage),
      },
      output: {
        messagesAfter: event.messagesAfter,
        messagesBefore: event.messagesBefore,
      },
    });
    state.span.end();
    this.deleteCompactionState(state);
  }

  private findCompactionState(event: FlueBaseEvent): SpanState | undefined {
    const operationState = this.operationStateForEvent(event);
    for (const state of this.compactionsByScope.values()) {
      if (operationState && state.operationState === operationState) {
        return state;
      }
    }
    return undefined;
  }

  private finishCompactionsForOperation(operationState: OperationState): void {
    for (const state of [...this.compactionsByScope.values()]) {
      if (state.operationState !== operationState) {
        continue;
      }
      safeLog(state.span, {
        metadata: state.metadata,
        metrics: {
          ...buildDurationMetrics(state.startTime),
        },
      });
      state.span.end();
      this.deleteCompactionState(state);
    }
  }

  private deleteCompactionState(state: SpanState): void {
    for (const [key, candidate] of this.compactionsByScope) {
      if (candidate !== state) {
        continue;
      }
      this.compactionsByScope.delete(key);
      return;
    }
  }

  private startSyntheticToolState(
    event: FlueToolCallEvent,
    toolName: string,
  ): SpanState {
    const parent = this.parentSpanForEvent(event);
    const metadata = {
      ...extractEventMetadata(event),
      ...(event.toolCallId ? { "flue.tool_call_id": event.toolCallId } : {}),
      "flue.tool_name": toolName,
      provider: "flue",
    };
    const span = startFlueSpan(parent, {
      name: `tool: ${toolName}`,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    });
    safeLog(span, { metadata });
    return { metadata, span, startTime: getCurrentUnixTimestamp() };
  }

  private operationStateForEvent(
    event: FlueBaseEvent,
  ): OperationState | undefined {
    if (event.operationId) {
      const operation =
        this.activeOperationsById.get(event.operationId) ??
        this.promotePendingOperationForEvent(event);
      if (operation) {
        return operation;
      }
    }
    return (
      this.activeOperationForEventScope(event) ??
      this.pendingOperationForEventScope(event)
    );
  }

  private parentSpanForEvent(event: FlueBaseEvent): Span | undefined {
    if (event.operationId) {
      const operation = this.operationStateForEvent(event);
      if (operation) {
        return operation.span;
      }
    }
    if (event.taskId) {
      return this.tasksById.get(event.taskId)?.span;
    }
    return this.operationStateForEvent(event)?.span;
  }

  private promotePendingOperationForEvent(
    event: FlueBaseEvent,
  ): OperationState | undefined {
    if (!event.operationId) {
      return undefined;
    }

    const scopePrefixes = operationScopePrefixes(event);
    for (const [candidateKey, candidateQueue] of this.pendingOperationsByKey) {
      if (
        !candidateQueue.length ||
        !operationKeyMatchesScopes(candidateKey, scopePrefixes)
      ) {
        continue;
      }

      const state = candidateQueue.shift();
      if (!state) {
        return undefined;
      }
      state.operationId = event.operationId;
      this.activeOperationsById.set(event.operationId, state);
      addScopedOperation(this.activeOperationsByScope, event, state);
      state.metadata = {
        ...state.metadata,
        ...extractEventMetadata(event),
        "flue.operation_id": event.operationId,
      };
      safeLog(state.span, { metadata: state.metadata });
      return state;
    }

    return undefined;
  }

  private activeOperationForEventScope(
    event: FlueBaseEvent,
  ): OperationState | undefined {
    for (const scope of operationScopeNames(event)) {
      const operations = this.activeOperationsByScope.get(scope);
      if (operations?.length) {
        return operations[operations.length - 1];
      }
    }

    return undefined;
  }

  private pendingOperationForEventScope(
    event: FlueBaseEvent,
  ): OperationState | undefined {
    const scopePrefixes = operationScopePrefixes(event);
    for (const [candidateKey, candidateQueue] of this.pendingOperationsByKey) {
      if (
        !candidateQueue.length ||
        !operationKeyMatchesScopes(candidateKey, scopePrefixes)
      ) {
        continue;
      }
      return candidateQueue[0];
    }

    return undefined;
  }

  private takePendingOperationForEvent(
    event: FlueOperationStartEvent,
  ): OperationState | undefined {
    const key = operationKey(event.session, event.operationKind);
    const queue = this.pendingOperationsByKey.get(key);
    if (queue?.length) {
      return queue.shift();
    }

    for (const [candidateKey, candidateQueue] of this.pendingOperationsByKey) {
      if (
        candidateKey.endsWith(`::${event.operationKind}`) &&
        candidateQueue.length
      ) {
        return candidateQueue.shift();
      }
    }

    return undefined;
  }

  private pendingOperationQueue(key: string): OperationState[] {
    const existing = this.pendingOperationsByKey.get(key);
    if (existing) {
      return existing;
    }
    const queue: OperationState[] = [];
    this.pendingOperationsByKey.set(key, queue);
    return queue;
  }
}

function isInstrumentedOperation(
  operation: FlueOperationKind | "shell",
): operation is FlueOperationKind {
  return (
    operation === "prompt" ||
    operation === "skill" ||
    operation === "task" ||
    operation === "compact"
  );
}

function getSessionName(session: FlueSession | undefined): string | undefined {
  return typeof session?.name === "string" ? session.name : undefined;
}

function operationKey(
  sessionName: string | undefined,
  operation: FlueOperationKind | "shell",
): string {
  return `${sessionName ?? "unknown"}::${operation}`;
}

function operationScopePrefixes(event: FlueBaseEvent): Set<string> {
  const scopes = new Set<string>();
  for (const scope of operationScopeNames(event)) {
    scopes.add(`${scope}::`);
  }
  return scopes;
}

function operationKeyMatchesScopes(key: string, scopes: Set<string>): boolean {
  for (const scope of scopes) {
    if (key.startsWith(scope)) {
      return true;
    }
  }
  return false;
}

function operationScopeNames(event: FlueBaseEvent): Set<string> {
  const scopes = new Set<string>();
  if (event.session) {
    scopes.add(event.session);
  }
  if (event.parentSession) {
    scopes.add(event.parentSession);
  }
  if (!scopes.size) {
    scopes.add("unknown");
  }
  return scopes;
}

function addScopedOperation(
  operationsByScope: Map<string, OperationState[]>,
  event: FlueBaseEvent,
  state: OperationState,
): void {
  for (const scope of operationScopeNames(event)) {
    addOperationToScope(operationsByScope, scope, state);
  }
}

function addOperationToScope(
  operationsByScope: Map<string, OperationState[]>,
  scope: string,
  state: OperationState,
): void {
  const operations = operationsByScope.get(scope);
  if (operations) {
    if (!operations.includes(state)) {
      operations.push(state);
    }
  } else {
    operationsByScope.set(scope, [state]);
  }
}

function removeScopedOperation(
  operationsByScope: Map<string, OperationState[]>,
  state: OperationState,
): void {
  for (const [scope, operations] of operationsByScope) {
    const index = operations.indexOf(state);
    if (index === -1) {
      continue;
    }
    operations.splice(index, 1);
    if (operations.length === 0) {
      operationsByScope.delete(scope);
    }
  }
}

function removePendingOperation(
  pendingOperationsByKey: Map<string, OperationState[]>,
  state: OperationState,
): void {
  for (const [key, queue] of pendingOperationsByKey) {
    const index = queue.indexOf(state);
    if (index === -1) {
      continue;
    }
    queue.splice(index, 1);
    if (queue.length === 0) {
      pendingOperationsByKey.delete(key);
    }
    return;
  }
}

function extractSessionMetadata(
  session: FlueSession | undefined,
): Record<string, unknown> {
  const sessionName = getSessionName(session);
  return sessionName ? { "flue.session": sessionName } : {};
}

function extractEventMetadata(event: FlueBaseEvent): Record<string, unknown> {
  return {
    ...(event.runId ? { "flue.run_id": event.runId } : {}),
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
  };
}

function extractOperationInput(
  operation: FlueOperationKind,
  args: ArrayLike<unknown>,
): unknown {
  switch (operation) {
    case "prompt":
    case "task":
      return args[0];
    case "skill":
      return {
        args: getOptionObject(args[1])?.args,
        name: args[0],
      };
    case "compact":
      return undefined;
  }
}

function extractOperationInputMetadata(
  operation: FlueOperationKind,
  args: ArrayLike<unknown>,
): Record<string, unknown> {
  const options = getOptionObject(args[1]);
  return {
    ...(operation === "skill" && typeof args[0] === "string"
      ? { "flue.skill_name": args[0] }
      : {}),
    ...(options?.model
      ? { model: options.model, "flue.model": options.model }
      : {}),
    ...(options?.role ? { "flue.role": options.role } : {}),
    ...(options?.thinkingLevel
      ? { "flue.thinking_level": options.thinkingLevel }
      : {}),
    ...(typeof options?.cwd === "string" ? { "flue.cwd": options.cwd } : {}),
    ...(Array.isArray(options?.tools)
      ? {
          "flue.tools_count": options.tools.length,
          tools: summarizeTools(options.tools),
        }
      : {}),
    ...(Array.isArray(options?.images)
      ? { "flue.images_count": options.images.length }
      : {}),
    ...(options?.result || options?.schema
      ? { "flue.result_schema": true }
      : {}),
  };
}

function getOptionObject(
  value: unknown,
): (FlueCallOptions & FlueSkillOptions & FlueTaskOptions) | undefined {
  return isObject(value)
    ? (value as FlueCallOptions & FlueSkillOptions & FlueTaskOptions)
    : undefined;
}

function summarizeTools(tools: unknown[]): unknown[] {
  return tools.flatMap((tool) => {
    if (!isObject(tool)) {
      return [];
    }
    const name = typeof tool.name === "string" ? tool.name : undefined;
    if (!name) {
      return [];
    }
    return [
      {
        function: {
          description:
            typeof tool.description === "string" ? tool.description : undefined,
          name,
          parameters: tool.parameters,
        },
        type: "function",
      },
    ];
  });
}

function extractPromptResponseMetadata(
  result: FluePromptResponse | undefined,
): Record<string, unknown> {
  const modelId =
    result?.model && typeof result.model.id === "string"
      ? result.model.id
      : undefined;
  return modelId
    ? {
        model: modelId,
        "flue.model": modelId,
      }
    : {};
}

function extractOperationOutput(
  result: FluePromptResponse | undefined,
): unknown {
  if (!result) {
    return undefined;
  }
  if ("data" in result) {
    return result.data;
  }
  if ("text" in result) {
    return result.text;
  }
  return result;
}

function metricsFromUsage(
  usage: FlueUsage | undefined,
): Record<string, number> {
  return {
    ...(typeof usage?.input === "number" ? { prompt_tokens: usage.input } : {}),
    ...(typeof usage?.output === "number"
      ? { completion_tokens: usage.output }
      : {}),
    ...(typeof usage?.cacheRead === "number"
      ? { prompt_cached_tokens: usage.cacheRead }
      : {}),
    ...(typeof usage?.cacheWrite === "number"
      ? { prompt_cache_creation_tokens: usage.cacheWrite }
      : {}),
    ...(typeof usage?.totalTokens === "number"
      ? { tokens: usage.totalTokens }
      : {}),
    ...(typeof usage?.cost?.total === "number"
      ? { estimated_cost: usage.cost.total }
      : {}),
  };
}

function buildDurationMetrics(startTime: number): Record<string, number> {
  return {
    duration_ms: Math.max(0, (getCurrentUnixTimestamp() - startTime) * 1000),
  };
}

function durationMsMetrics(durationMs: unknown): Record<string, number> {
  return typeof durationMs === "number" ? { duration_ms: durationMs } : {};
}

function scopeKey(event: FlueBaseEvent): string {
  if (event.operationId) {
    return `operation:${event.operationId}`;
  }
  if (event.taskId) {
    return `task:${event.taskId}`;
  }
  if (event.session) {
    return `session:${event.session}`;
  }
  return "flue:unknown";
}

function toolKey(
  event: Pick<FlueBaseEvent, "operationId" | "taskId" | "session"> & {
    toolCallId?: string;
  },
): string {
  return `${scopeKey(event)}::tool:${event.toolCallId ?? "unknown"}`;
}

function toAssistantOutput(
  text: string,
  finishReason: string | undefined,
  reasoning?: string,
  toolCalls?: Array<{
    args?: unknown;
    toolCallId?: string;
    toolName?: string;
  }>,
): unknown {
  return [
    {
      finish_reason: finishReason ?? "stop",
      index: 0,
      message: {
        content: text,
        ...(reasoning ? { reasoning } : {}),
        role: "assistant",
        ...(toolCalls?.length
          ? {
              tool_calls: toolCalls.map((toolCall) => ({
                function: {
                  arguments:
                    toolCall.args === undefined
                      ? "{}"
                      : JSON.stringify(toolCall.args),
                  name: toolCall.toolName ?? "unknown",
                },
                ...(toolCall.toolCallId ? { id: toolCall.toolCallId } : {}),
                type: "function",
              })),
            }
          : {}),
      },
    },
  ];
}

function startFlueSpan(
  parent: Span | undefined,
  args: Parameters<typeof startSpan>[0],
): Span {
  return parent ? withCurrent(parent, () => startSpan(args)) : startSpan(args);
}

function safeLog(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    logInstrumentationError("Flue span log", error);
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
