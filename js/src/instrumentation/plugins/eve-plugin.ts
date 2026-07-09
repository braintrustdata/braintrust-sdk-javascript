import { toLoggedError } from "../core";
import { debugLogger } from "../../debug-logger";
import { flush, logError, startSpan } from "../../logger";
import type { Span } from "../../logger";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import type {
  EveAssistantStepFinishReason,
  EveHandleMessageStreamEvent,
  EveHookContext,
  EveHookDefinition,
  EveRuntimeActionRequest,
  EveRuntimeActionResult,
  EveRuntimeToolCallActionRequest,
  EveRuntimeToolResultActionResult,
} from "../../vendor-sdk-types/eve";

type SpanState = {
  metadata: Record<string, unknown>;
  span: Span;
};

type ToolCall = {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type: "function";
};

type AssistantToolCallMessage = {
  content: unknown;
  role: "assistant";
  tool_calls: ToolCall[];
};

type StepState = SpanState & {
  assistantToolCallMessage?: AssistantToolCallMessage;
  metrics: Record<string, number>;
  ordinal: number;
  output?: unknown;
  toolCalls: ToolCall[];
};

type TurnState = SpanState & {
  inputLogged: boolean;
  key: string;
  messages: unknown[];
  metrics: Record<string, number>;
  nextStepOrdinal: number;
  output?: unknown;
  stepsByIndex: Map<number, StepState>;
};

type ToolState = SpanState & {
  endedByTurn?: boolean;
  kind: "subagent" | "tool";
  stepIndex?: number;
  stepOrdinal?: number;
  turnKey: string;
};

type ParentLineage = {
  callId: string;
  rootSessionId: string;
  sessionId: string;
  turnId?: string;
  turnSequence?: number;
};

const EVE_BRIDGE = Symbol.for("braintrust.eve.bridge");

/** Manual hook instrumentation for eve runtime stream events. */
export function braintrustEveHook(
  options: { metadata?: Record<string, unknown> } = {},
): EveHookDefinition {
  return {
    events: {
      "*": async (event: EveHandleMessageStreamEvent, ctx: EveHookContext) => {
        await getEveBridge().handle(event, ctx, options.metadata);
      },
    },
  };
}

function getEveBridge(): EveBridge {
  const existing = Reflect.get(globalThis, EVE_BRIDGE);
  if (existing instanceof EveBridge) {
    return existing;
  }
  const bridge = new EveBridge();
  Reflect.set(globalThis, EVE_BRIDGE, bridge);
  return bridge;
}

class EveBridge {
  private sessionsById = new Map<
    string,
    { metadata: Record<string, unknown> }
  >();
  private completedToolKeys = new Set<string>();
  private queue = Promise.resolve();
  private toolsByCallKey = new Map<string, ToolState>();
  private turnsByKey = new Map<string, TurnState>();

  handle(
    event: unknown,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!isObject(event)) {
      return Promise.resolve();
    }

    const next = this.queue
      .then(() =>
        this.handleEvent(
          event as EveHandleMessageStreamEvent,
          ctx,
          hookMetadata,
        ),
      )
      .catch(() => undefined);
    this.queue = next;
    return next;
  }

  private async handleEvent(
    event: EveHandleMessageStreamEvent,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Promise<void> {
    switch (event.type) {
      case "session.started":
        this.handleSessionStarted(event, ctx);
        return;
      case "turn.started":
        await this.handleTurnStarted(event, ctx, hookMetadata);
        return;
      case "message.received":
        await this.handleMessageReceived(event, ctx, hookMetadata);
        return;
      case "step.started":
        await this.handleStepStarted(event, ctx, hookMetadata);
        return;
      case "message.completed":
        this.handleMessageCompleted(event, ctx);
        return;
      case "result.completed":
        this.handleResultCompleted(event, ctx);
        return;
      case "actions.requested":
        await this.handleActionsRequested(event, ctx, hookMetadata);
        return;
      case "action.result":
        await this.handleActionResult(event, ctx, hookMetadata);
        return;
      case "subagent.called":
        await this.handleSubagentCalled(event, ctx, hookMetadata);
        return;
      case "subagent.completed":
        await this.handleSubagentCompleted(event, ctx, hookMetadata);
        return;
      case "step.completed":
        this.handleStepCompleted(event, ctx);
        return;
      case "step.failed":
        this.handleStepFailed(event, ctx);
        return;
      case "turn.completed":
        await this.handleTurnCompleted(event, ctx);
        return;
      case "turn.failed":
        await this.handleTurnFailed(event, ctx);
        return;
      case "session.failed":
        await this.handleSessionFailed(event, ctx);
        return;
      case "session.completed":
        this.handleSessionCompleted(ctx);
        return;
      default:
        return;
    }
  }

  private handleSessionStarted(
    event: Extract<EveHandleMessageStreamEvent, { type: "session.started" }>,
    ctx: unknown,
  ): void {
    const sessionId = sessionIdFromContext(ctx);
    const metadata = modelMetadataFromRuntime(event.data.runtime);
    if (!sessionId || Object.keys(metadata).length === 0) {
      return;
    }

    this.sessionsById.set(sessionId, { metadata });
    for (const [key, turn] of this.turnsByKey) {
      if (!key.startsWith(`${sessionId}:`)) {
        continue;
      }

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

    const key = turnKey(sessionId, event.data.turnId);
    const metadata = { ...(hookMetadata ?? {}) };
    const existing = this.turnsByKey.get(key);
    if (existing) {
      existing.metadata = metadata;
      existing.span.log({ metadata });
      return;
    }

    const span = await this.startTurnSpan(sessionId, event, ctx, metadata);
    span.log({ metadata });
    this.turnsByKey.set(key, {
      inputLogged: false,
      key,
      messages: [],
      metadata,
      metrics: {},
      nextStepOrdinal: 0,
      span,
      stepsByIndex: new Map(),
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
    turn.messages.push(...input);
    if (!turn.inputLogged) {
      turn.inputLogged = true;
      turn.span.log({ input });
    }
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
        metadata: existing.metadata,
        metrics: existing.metrics,
        output: existing.output,
      });
      const endTime = eventTime(event);
      existing.span.end(endTime === undefined ? undefined : { endTime });
    }

    const stepOrdinal = turn.nextStepOrdinal++;
    const metadata = {
      ...turn.metadata,
      ...(this.sessionsById.get(sessionId)?.metadata ?? {}),
    };
    const input = turn.messages.length > 0 ? [...turn.messages] : undefined;
    const [eventId, spanId] = await Promise.all([
      rowIdForStep(sessionId, event.data.turnId, stepOrdinal),
      spanIdForStep(sessionId, event.data.turnId, stepOrdinal),
    ]);
    const span = startChildSpan(turn.span, {
      event: {
        id: eventId,
        input,
        metadata,
      },
      name: "eve.step",
      spanAttributes: { type: SpanTypeAttribute.LLM },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ input, metadata });

    turn.stepsByIndex.set(event.data.stepIndex, {
      metadata,
      metrics: {},
      ordinal: stepOrdinal,
      span,
      toolCalls: [],
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

    step.output = [
      {
        finish_reason: normalizedFinishReason(event.data.finishReason),
        index: 0,
        message: {
          content: event.data.message,
          role: "assistant",
          ...(step.toolCalls.length > 0
            ? { tool_calls: [...step.toolCalls] }
            : {}),
        },
      },
    ];
    if (step.assistantToolCallMessage) {
      step.assistantToolCallMessage.content = event.data.message;
      step.assistantToolCallMessage.tool_calls = [...step.toolCalls];
    }

    const turn = this.turnForEvent(event, ctx);
    if (turn && event.data.finishReason !== "tool-calls") {
      turn.output = event.data.message;
      turn.messages.push({
        content: event.data.message,
        role: "assistant",
      });
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

    const step = turn.stepsByIndex.get(event.data.stepIndex);
    const traceActions = event.data.actions.filter(isTraceableActionRequest);
    if (traceActions.length === 0) {
      return;
    }

    for (const action of traceActions) {
      if (step) {
        const toolCall = toolCallMessageFromAction(action);
        if (!step.toolCalls.some((existing) => existing.id === toolCall.id)) {
          step.toolCalls.push(toolCall);
        }
      }

      if (isToolCallAction(action)) {
        await this.startRequestedTool(event, turn, sessionId, action, step);
      } else if (isLocalSubagentCallAction(action)) {
        await this.startRequestedSubagent(event, turn, sessionId, action, step);
      }
    }

    if (!step) {
      turn.messages.push({
        content: null,
        role: "assistant",
        tool_calls: traceActions.map(toolCallMessageFromAction),
      });
      return;
    }

    const outputChoice =
      Array.isArray(step.output) && isObject(step.output[0])
        ? step.output[0]
        : undefined;
    const outputMessage = outputChoice
      ? Reflect.get(outputChoice, "message")
      : undefined;
    const content = isObject(outputMessage)
      ? Reflect.get(outputMessage, "content")
      : null;
    if (!step.assistantToolCallMessage) {
      step.assistantToolCallMessage = {
        content,
        role: "assistant",
        tool_calls: [...step.toolCalls],
      };
      turn.messages.push(step.assistantToolCallMessage);
    } else {
      step.assistantToolCallMessage.content = content;
      step.assistantToolCallMessage.tool_calls = [...step.toolCalls];
    }

    if (isObject(outputMessage)) {
      Reflect.set(outputMessage, "tool_calls", [...step.toolCalls]);
    } else {
      step.output = [
        {
          finish_reason: "tool_calls",
          index: 0,
          message: {
            content,
            role: "assistant",
            tool_calls: [...step.toolCalls],
          },
        },
      ];
    }
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
    const flushAfterCompletion = tool.endedByTurn === true;

    const failed =
      event.data.status === "failed" ||
      result.isError === true ||
      event.data.error !== undefined;
    tool.span.log({
      ...(failed
        ? {
            error: toLoggedError(event.data.error?.message ?? result.output),
          }
        : {}),
      metadata: tool.metadata,
      output: result.output,
    });

    const turn = this.turnForEvent(event, ctx);
    turn?.messages.push({
      content: toolMessageContent(result.output),
      name: result.toolName,
      role: "tool",
      tool_call_id: result.callId,
    });

    const endTime = eventTime(event);
    tool.span.end(endTime === undefined ? undefined : { endTime });
    this.toolsByCallKey.delete(key);
    this.completedToolKeys.add(key);
    if (flushAfterCompletion) {
      await this.flushInstrumentation();
    }
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
    const metadata = { ...turn.metadata };
    const existing = this.toolsByCallKey.get(key);
    if (existing) {
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.span.log({ metadata: existing.metadata });
      return;
    }

    const [eventId, spanId] = await Promise.all([
      rowIdForSubagent(sessionId, event.data.callId),
      spanIdForSubagent(sessionId, event.data.callId),
    ]);
    const span = startChildSpan(turn.span, {
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
      kind: "subagent",
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
    const flushAfterCompletion = subagent.endedByTurn === true;

    this.completeSubagentSpan({
      endTime: eventTime(event),
      error: event.data.error,
      isError: event.data.status === "failed",
      output: event.data.output,
      spanState: subagent,
      status: event.data.status,
    });

    const turn = this.turnForEvent(event, ctx);
    turn?.messages.push({
      content: toolMessageContent(event.data.output),
      name: event.data.subagentName,
      role: "tool",
      tool_call_id: event.data.callId,
    });

    this.toolsByCallKey.delete(key);
    this.completedToolKeys.add(key);
    if (flushAfterCompletion) {
      await this.flushInstrumentation();
    }
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
    const flushAfterCompletion = subagent.endedByTurn === true;

    this.completeSubagentSpan({
      endTime: eventTime(event),
      error: event.data.error,
      isError:
        event.data.status === "failed" ||
        result.isError === true ||
        event.data.error !== undefined,
      output: result.output,
      spanState: subagent,
      status: event.data.status,
    });

    const turn = this.turnForEvent(event, ctx);
    turn?.messages.push({
      content: toolMessageContent(result.output),
      name: result.subagentName,
      role: "tool",
      tool_call_id: result.callId,
    });

    this.toolsByCallKey.delete(key);
    this.completedToolKeys.add(key);
    if (flushAfterCompletion) {
      await this.flushInstrumentation();
    }
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
      const finishReason = Reflect.get(step.output[0], "finish_reason");
      if (typeof finishReason !== "string") {
        Reflect.set(
          step.output[0],
          "finish_reason",
          normalizedFinishReason(event.data.finishReason),
        );
      }
    }
    step.span.log({
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
  }

  private handleStepFailed(
    event: Extract<EveHandleMessageStreamEvent, { type: "step.failed" }>,
    ctx: unknown,
  ): void {
    const step = this.stepForEvent(event, ctx);
    if (step) {
      logError(
        step.span,
        errorFromMessage(
          event.data.message,
          event.data.code,
          event.data.details,
        ),
      );
      const endTime = eventTime(event);
      step.span.end(endTime === undefined ? undefined : { endTime });
    }

    const turn = this.turnForEvent(event, ctx);
    turn?.stepsByIndex.delete(event.data.stepIndex);
  }

  private async handleTurnCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "turn.completed" }>,
    ctx: unknown,
  ): Promise<void> {
    const turn = this.turnForEvent(event, ctx);
    if (!turn) {
      return;
    }

    this.endOpenChildrenForTurn(turn, eventTime(event));
    turn.span.log({
      metadata: turn.metadata,
      metrics: turn.metrics,
      output: turn.output,
    });
    const endTime = eventTime(event);
    turn.span.end(endTime === undefined ? undefined : { endTime });
    this.cleanupTurn(event, ctx);

    await this.flushInstrumentation();
  }

  private async handleTurnFailed(
    event: Extract<EveHandleMessageStreamEvent, { type: "turn.failed" }>,
    ctx: unknown,
  ): Promise<void> {
    const turn = this.turnForEvent(event, ctx);
    if (!turn) {
      return;
    }

    this.endOpenChildrenForTurn(turn, eventTime(event));
    logError(
      turn.span,
      errorFromMessage(event.data.message, event.data.code, event.data.details),
    );
    const endTime = eventTime(event);
    turn.span.end(endTime === undefined ? undefined : { endTime });
    this.cleanupTurn(event, ctx);

    await this.flushInstrumentation();
  }

  private async handleSessionFailed(
    event: Extract<EveHandleMessageStreamEvent, { type: "session.failed" }>,
    ctx: unknown,
  ): Promise<void> {
    const sessionId = event.data.sessionId || sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    for (const [key, turn] of this.turnsByKey) {
      if (!key.startsWith(`${sessionId}:`)) {
        continue;
      }
      this.endOpenChildrenForTurn(turn, eventTime(event));
      logError(
        turn.span,
        errorFromMessage(
          event.data.message,
          event.data.code,
          event.data.details,
        ),
      );
      const endTime = eventTime(event);
      turn.span.end(endTime === undefined ? undefined : { endTime });
      this.turnsByKey.delete(key);
    }

    for (const [key, tool] of this.toolsByCallKey) {
      if (key.startsWith(`${sessionId}:`)) {
        const endTime = eventTime(event);
        tool.span.end(endTime === undefined ? undefined : { endTime });
        this.toolsByCallKey.delete(key);
      }
    }

    this.sessionsById.delete(sessionId);

    await this.flushInstrumentation();
  }

  private handleSessionCompleted(ctx: unknown): void {
    const sessionId = sessionIdFromContext(ctx);
    if (sessionId) {
      this.sessionsById.delete(sessionId);
      for (const key of this.toolsByCallKey.keys()) {
        if (key.startsWith(`${sessionId}:`)) {
          this.toolsByCallKey.delete(key);
        }
      }
      for (const completedKey of this.completedToolKeys) {
        if (completedKey.startsWith(`${sessionId}:`)) {
          this.completedToolKeys.delete(completedKey);
        }
      }
    }
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

    const key = turnKey(sessionId, event.data.turnId);
    const existing = this.turnsByKey.get(key);
    if (existing) {
      return existing;
    }

    const metadata = { ...(hookMetadata ?? {}) };
    const span = await this.startTurnSpan(sessionId, event, ctx, metadata);
    span.log({ metadata });
    const state = {
      inputLogged: false,
      key,
      messages: [],
      metadata,
      metrics: {},
      nextStepOrdinal: 0,
      span,
      stepsByIndex: new Map<number, StepState>(),
    };
    this.turnsByKey.set(key, state);
    return state;
  }

  private async startRequestedTool(
    event: Extract<EveHandleMessageStreamEvent, { type: "actions.requested" }>,
    turn: TurnState,
    sessionId: string,
    action: EveRuntimeToolCallActionRequest,
    step?: StepState,
  ): Promise<void> {
    const key = toolKey(sessionId, action.callId);
    if (this.toolsByCallKey.has(key)) {
      return;
    }

    const metadata = { ...turn.metadata };
    const [eventId, spanId] = await Promise.all([
      rowIdForTool(sessionId, event.data.turnId, action.callId),
      spanIdForTool(sessionId, event.data.turnId, action.callId),
    ]);
    const span = startChildSpan(turn.span, {
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
      kind: "tool",
      metadata,
      span,
      stepIndex: event.data.stepIndex,
      stepOrdinal: step?.ordinal,
      turnKey: turnKey(sessionId, event.data.turnId),
    });
  }

  private async startRequestedSubagent(
    event: Extract<EveHandleMessageStreamEvent, { type: "actions.requested" }>,
    turn: TurnState,
    sessionId: string,
    action: Extract<EveRuntimeActionRequest, { kind: "subagent-call" }>,
    step?: StepState,
  ): Promise<void> {
    const key = toolKey(sessionId, action.callId);
    if (this.toolsByCallKey.has(key)) {
      return;
    }

    const name = action.subagentName ?? action.name ?? "agent";
    const metadata = { ...turn.metadata };
    const [eventId, spanId] = await Promise.all([
      rowIdForSubagent(sessionId, action.callId),
      spanIdForSubagent(sessionId, action.callId),
    ]);
    const span = startChildSpan(turn.span, {
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
      kind: "subagent",
      metadata,
      span,
      stepIndex: event.data.stepIndex,
      stepOrdinal: step?.ordinal,
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

    const metadata = { ...turn.metadata };
    const [eventId, spanId] = await Promise.all([
      rowIdForTool(sessionId, event.data.turnId, result.callId),
      spanIdForTool(sessionId, event.data.turnId, result.callId),
    ]);
    const span = startChildSpan(turn.span, {
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
      kind: "tool" as const,
      metadata,
      span,
      stepIndex: event.data.stepIndex,
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

    const metadata = { ...turn.metadata };
    const [eventId, spanId] = await Promise.all([
      rowIdForSubagent(sessionId, event.data.callId),
      spanIdForSubagent(sessionId, event.data.callId),
    ]);
    const span = startChildSpan(turn.span, {
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
      kind: "subagent" as const,
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

    const metadata = { ...turn.metadata };
    const [eventId, spanId] = await Promise.all([
      rowIdForSubagent(sessionId, result.callId),
      spanIdForSubagent(sessionId, result.callId),
    ]);
    const span = startChildSpan(turn.span, {
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
      kind: "subagent" as const,
      metadata,
      span,
      stepIndex: event.data.stepIndex,
      turnKey: turnKey(sessionId, event.data.turnId),
    };
    this.toolsByCallKey.set(toolKey(sessionId, result.callId), state);
    return state;
  }

  private completeSubagentSpan(input: {
    endTime: number | undefined;
    error?: { readonly message?: string };
    isError: boolean;
    output: unknown;
    spanState: ToolState;
    status?: string;
  }): void {
    input.spanState.span.log({
      ...(input.isError
        ? { error: toLoggedError(input.error?.message ?? input.output) }
        : {}),
      metadata: input.spanState.metadata,
      output: input.output,
    });
    input.spanState.span.end(
      input.endTime === undefined ? undefined : { endTime: input.endTime },
    );
  }

  private async startTurnSpan(
    sessionId: string,
    event: Extract<
      EveHandleMessageStreamEvent,
      { data: { readonly sequence: number; readonly turnId: string } }
    >,
    ctx: unknown,
    metadata: Record<string, unknown>,
  ): Promise<Span> {
    const lineage = parentLineageFromContext(ctx);
    if (lineage) {
      await this.recordChildSessionOnParentSubagent(event, ctx, lineage);
    }
    const parentSubagent = lineage
      ? this.toolsByCallKey.get(toolKey(lineage.sessionId, lineage.callId))
      : undefined;
    const [eventId, spanId, parentSubagentSpanId, fallbackRootSpanId] =
      await Promise.all([
        rowIdForTurn(sessionId, event.data.turnId),
        spanIdForTurn(sessionId, event.data.turnId),
        lineage
          ? spanIdForSubagent(lineage.sessionId, lineage.callId)
          : Promise.resolve(undefined),
        lineage ? rootSpanIdForLineage(lineage) : Promise.resolve(undefined),
      ]);
    const rootSpanId = parentSubagent?.span.rootSpanId ?? fallbackRootSpanId;

    return startSpan({
      event: {
        id: eventId,
        metadata,
      },
      name: "eve.turn",
      ...(lineage && parentSubagentSpanId && rootSpanId
        ? {
            parentSpanIds: {
              rootSpanId,
              spanId: parentSubagentSpanId,
            },
          }
        : {}),
      spanAttributes: { type: SpanTypeAttribute.TASK },
      spanId,
      startTime: eventTime(event),
    });
  }

  private async recordChildSessionOnParentSubagent(
    event: Extract<
      EveHandleMessageStreamEvent,
      { data: { readonly sequence: number; readonly turnId: string } }
    >,
    ctx: unknown,
    lineage: ParentLineage,
  ): Promise<void> {
    const subagentName = subagentNameFromContext(ctx);
    const existing = this.toolsByCallKey.get(
      toolKey(lineage.sessionId, lineage.callId),
    );
    if (existing) {
      return;
    }

    if (!lineage.turnId || typeof lineage.turnSequence !== "number") {
      return;
    }

    const metadata = {};
    const [eventId, spanId, parentTurnSpanId, rootSpanId] = await Promise.all([
      rowIdForSubagent(lineage.sessionId, lineage.callId),
      spanIdForSubagent(lineage.sessionId, lineage.callId),
      spanIdForTurn(lineage.sessionId, lineage.turnId),
      rootSpanIdForLineage(lineage),
    ]);
    const parentTurn = this.turnsByKey.get(
      turnKey(lineage.sessionId, lineage.turnId),
    );
    const span = startSpan({
      event: {
        id: eventId,
        metadata,
      },
      name: subagentName ?? "agent",
      parentSpanIds: {
        rootSpanId: parentTurn?.span.rootSpanId ?? rootSpanId,
        spanId: parentTurnSpanId,
      },
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      spanId,
      startTime: eventTime(event),
    });
    span.log({ metadata });
    this.toolsByCallKey.set(toolKey(lineage.sessionId, lineage.callId), {
      kind: "subagent",
      metadata,
      span,
      turnKey: turnKey(lineage.sessionId, lineage.turnId),
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

  private endOpenChildrenForTurn(turn: TurnState, endTime: number | undefined) {
    for (const step of turn.stepsByIndex.values()) {
      step.span.log({
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
      tool.span.log({ metadata: tool.metadata });
      tool.span.end(endTime === undefined ? undefined : { endTime });
      tool.endedByTurn = true;
    }
  }

  private cleanupTurn(
    event: Extract<
      EveHandleMessageStreamEvent,
      { data: { readonly turnId: string } }
    >,
    ctx: unknown,
  ): void {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }
    const key = turnKey(sessionId, event.data.turnId);
    this.turnsByKey.delete(key);
  }

  private async flushInstrumentation(): Promise<void> {
    try {
      await flush();
    } catch (error) {
      debugLogger.warn("Error in Eve flush instrumentation:", error);
    }
  }
}

function subagentNameFromContext(ctx: unknown): string | undefined {
  if (!isObject(ctx)) {
    return undefined;
  }
  const agent = Reflect.get(ctx, "agent");
  if (!isObject(agent)) {
    return undefined;
  }
  const name = Reflect.get(agent, "name");
  return typeof name === "string" ? name : undefined;
}

function modelMetadataFromRuntime(runtime: unknown): Record<string, unknown> {
  if (!isObject(runtime)) {
    return {};
  }
  const modelId = Reflect.get(runtime, "modelId");
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
  const session = Reflect.get(ctx, "session");
  if (!isObject(session)) {
    return undefined;
  }
  const id = Reflect.get(session, "id");
  return typeof id === "string" ? id : undefined;
}

function parentLineageFromContext(ctx: unknown): ParentLineage | undefined {
  if (!isObject(ctx)) {
    return undefined;
  }
  const session = Reflect.get(ctx, "session");
  if (!isObject(session)) {
    return undefined;
  }
  const parent = Reflect.get(session, "parent");
  if (!isObject(parent)) {
    return undefined;
  }

  const callId = Reflect.get(parent, "callId");
  const rootSessionId = Reflect.get(parent, "rootSessionId");
  const sessionId = Reflect.get(parent, "sessionId");
  if (
    typeof callId !== "string" ||
    typeof rootSessionId !== "string" ||
    typeof sessionId !== "string"
  ) {
    return undefined;
  }

  const turn = Reflect.get(parent, "turn");
  const turnId = isObject(turn) ? Reflect.get(turn, "id") : undefined;
  const turnSequence = isObject(turn)
    ? Reflect.get(turn, "sequence")
    : undefined;
  return {
    callId,
    rootSessionId,
    sessionId,
    ...(typeof turnId === "string" ? { turnId } : {}),
    ...(typeof turnSequence === "number" ? { turnSequence } : {}),
  };
}

function isToolCallAction(
  action: unknown,
): action is EveRuntimeToolCallActionRequest {
  return (
    isObject(action) &&
    Reflect.get(action, "kind") === "tool-call" &&
    typeof Reflect.get(action, "callId") === "string" &&
    typeof Reflect.get(action, "toolName") === "string" &&
    isObject(Reflect.get(action, "input"))
  );
}

function isLocalSubagentCallAction(
  action: unknown,
): action is Extract<EveRuntimeActionRequest, { kind: "subagent-call" }> {
  return (
    isObject(action) &&
    Reflect.get(action, "kind") === "subagent-call" &&
    typeof Reflect.get(action, "callId") === "string" &&
    isObject(Reflect.get(action, "input"))
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
    Reflect.get(result, "kind") === "tool-result" &&
    typeof Reflect.get(result, "callId") === "string" &&
    typeof Reflect.get(result, "toolName") === "string"
  );
}

function isSubagentResult(
  result: unknown,
): result is Extract<EveRuntimeActionResult, { kind: "subagent-result" }> {
  return (
    isObject(result) &&
    Reflect.get(result, "kind") === "subagent-result" &&
    typeof Reflect.get(result, "callId") === "string" &&
    typeof Reflect.get(result, "subagentName") === "string"
  );
}

function toolCallMessageFromAction(
  action:
    | EveRuntimeToolCallActionRequest
    | Extract<EveRuntimeActionRequest, { kind: "subagent-call" }>,
): ToolCall {
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
}

function toolMessageContent(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  try {
    const serialized = JSON.stringify(output);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // Fall back to a string representation for unexpected hook payloads.
  }
  return output === undefined || output === null ? "" : String(output);
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

async function rootSpanIdForLineage(lineage: ParentLineage): Promise<string> {
  if (lineage.turnId) {
    return spanIdForTurn(lineage.sessionId, lineage.turnId);
  }
  return rootSpanIdForSession(lineage.rootSessionId);
}

async function spanIdForTurn(
  sessionId: string,
  turnId: string,
): Promise<string> {
  return deterministicEveId("eve:turn", sessionId, turnId);
}

async function rowIdForTurn(
  sessionId: string,
  turnId: string,
): Promise<string> {
  return deterministicEveId("eve:row:turn", sessionId, turnId);
}

async function spanIdForStep(
  sessionId: string,
  turnId: string,
  stepOrdinal: number,
): Promise<string> {
  return deterministicEveId("eve:step", sessionId, turnId, String(stepOrdinal));
}

async function rowIdForStep(
  sessionId: string,
  turnId: string,
  stepOrdinal: number,
): Promise<string> {
  return deterministicEveId(
    "eve:row:step",
    sessionId,
    turnId,
    String(stepOrdinal),
  );
}

async function spanIdForTool(
  sessionId: string,
  turnId: string,
  callId: string,
): Promise<string> {
  return deterministicEveId("eve:tool", sessionId, turnId, callId);
}

async function rowIdForTool(
  sessionId: string,
  turnId: string,
  callId: string,
): Promise<string> {
  return deterministicEveId("eve:row:tool", sessionId, turnId, callId);
}

async function spanIdForSubagent(
  sessionId: string,
  callId: string,
): Promise<string> {
  return deterministicEveId("eve:subagent", sessionId, callId);
}

async function rowIdForSubagent(
  sessionId: string,
  callId: string,
): Promise<string> {
  return deterministicEveId("eve:row:subagent", sessionId, callId);
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

function startChildSpan(
  parent: Span,
  args: Parameters<typeof startSpan>[0],
): Span {
  return startSpan({
    ...args,
    parentSpanIds: {
      rootSpanId: parent.rootSpanId,
      spanId: parent.spanId,
    },
  });
}
