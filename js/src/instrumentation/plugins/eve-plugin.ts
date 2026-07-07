import { toLoggedError } from "../core";
import { debugLogger } from "../../debug-logger";
import { flush, logError, startSpan, withCurrent } from "../../logger";
import type { Span, StartSpanArgs } from "../../logger";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import type {
  EveHandleMessageStreamEvent,
  EveHookContext,
  EveHookDefinition,
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
  output?: unknown;
  toolCalls: ToolCall[];
};

type TurnState = SpanState & {
  inputLogged: boolean;
  messages: unknown[];
  metrics: Record<string, number>;
  output?: unknown;
  stepsByIndex: Map<number, StepState>;
};

type ToolState = SpanState & {
  stepIndex?: number;
  turnKey: string;
};

const EVE_BRIDGE = Symbol.for("braintrust.eve.bridge");

/** Manual hook instrumentation for eve runtime stream events. */
export function braintrustEveHook(
  options: { metadata?: Record<string, unknown> } = {},
): EveHookDefinition {
  return {
    events: {
      "*": (event: EveHandleMessageStreamEvent, ctx: EveHookContext) => {
        getEveBridge().handle(event, ctx, options.metadata);
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
  private toolsByCallKey = new Map<string, ToolState>();
  private turnsByKey = new Map<string, TurnState>();

  handle(
    event: unknown,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): void {
    if (!isObject(event)) {
      return;
    }

    try {
      this.handleEvent(event as EveHandleMessageStreamEvent, ctx, hookMetadata);
    } catch (error) {
      logInstrumentationError("Eve hook event", error);
    }
  }

  private handleEvent(
    event: EveHandleMessageStreamEvent,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): void {
    switch (event.type) {
      case "session.started":
        this.handleSessionStarted(event, ctx);
        return;
      case "turn.started":
        this.handleTurnStarted(event, ctx, hookMetadata);
        return;
      case "message.received":
        this.handleMessageReceived(event, ctx, hookMetadata);
        return;
      case "step.started":
        this.handleStepStarted(event, ctx, hookMetadata);
        return;
      case "message.completed":
        this.handleMessageCompleted(event, ctx);
        return;
      case "result.completed":
        this.handleResultCompleted(event, ctx);
        return;
      case "actions.requested":
        this.handleActionsRequested(event, ctx, hookMetadata);
        return;
      case "action.result":
        this.handleActionResult(event, ctx, hookMetadata);
        return;
      case "step.completed":
        this.handleStepCompleted(event, ctx);
        return;
      case "step.failed":
        this.handleStepFailed(event, ctx);
        return;
      case "turn.completed":
        this.handleTurnCompleted(event, ctx);
        return;
      case "turn.failed":
        this.handleTurnFailed(event, ctx);
        return;
      case "session.failed":
        this.handleSessionFailed(event, ctx);
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

      turn.metadata = { ...turn.metadata, ...metadata };
      safeLog(turn.span, { metadata: turn.metadata });
      for (const step of turn.stepsByIndex.values()) {
        step.metadata = { ...step.metadata, ...metadata };
        safeLog(step.span, { metadata: step.metadata });
      }
    }
  }

  private handleTurnStarted(
    event: Extract<EveHandleMessageStreamEvent, { type: "turn.started" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): void {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    const key = turnKey(sessionId, event.data.turnId);
    const metadata = this.turnMetadata(sessionId, event, ctx, hookMetadata);
    const existing = this.turnsByKey.get(key);
    if (existing) {
      existing.metadata = metadata;
      safeLog(existing.span, { metadata });
      return;
    }

    const span = startSpan({
      event: { metadata },
      name: "eve.turn",
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event),
    });
    safeLog(span, { metadata });
    this.turnsByKey.set(key, {
      inputLogged: false,
      messages: [],
      metadata,
      metrics: {},
      span,
      stepsByIndex: new Map(),
    });
  }

  private handleMessageReceived(
    event: Extract<EveHandleMessageStreamEvent, { type: "message.received" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): void {
    const turn = this.ensureTurn(event, ctx, hookMetadata);
    if (!turn) {
      return;
    }

    const input = [{ content: event.data.message, role: "user" }];
    turn.messages.push(...input);
    if (!turn.inputLogged) {
      turn.inputLogged = true;
      safeLog(turn.span, { input });
    }
  }

  private handleStepStarted(
    event: Extract<EveHandleMessageStreamEvent, { type: "step.started" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): void {
    const turn = this.ensureTurn(event, ctx, hookMetadata);
    if (!turn) {
      return;
    }

    const metadata = {
      ...turn.metadata,
      "eve.step.index": event.data.stepIndex,
    };
    const span = startEveSpan(turn.span, {
      event: {
        input: turn.messages.length > 0 ? [...turn.messages] : undefined,
        metadata,
      },
      name: "eve.step",
      spanAttributes: { type: SpanTypeAttribute.LLM },
      startTime: eventTime(event),
    });
    safeLog(span, {
      input: turn.messages.length > 0 ? [...turn.messages] : undefined,
      metadata,
    });

    turn.stepsByIndex.set(event.data.stepIndex, {
      metadata,
      metrics: {},
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

    step.output = {
      finish_reason: event.data.finishReason,
      message: {
        content: event.data.message,
        role: "assistant",
        ...(step.toolCalls.length > 0
          ? { tool_calls: [...step.toolCalls] }
          : {}),
      },
    };
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
      step.output = event.data.result;
    }

    const turn = this.turnForEvent(event, ctx);
    if (turn) {
      turn.output = event.data.result;
    }
  }

  private handleActionsRequested(
    event: Extract<EveHandleMessageStreamEvent, { type: "actions.requested" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): void {
    const turn = this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return;
    }

    const step = turn.stepsByIndex.get(event.data.stepIndex);
    const toolActions = event.data.actions.filter(isToolCallAction);
    if (toolActions.length === 0) {
      return;
    }

    for (const action of toolActions) {
      if (step) {
        const toolCall = openAIToolCallFromAction(action);
        if (!step.toolCalls.some((existing) => existing.id === toolCall.id)) {
          step.toolCalls.push(toolCall);
        }
      }

      const key = toolKey(sessionId, action.callId);
      if (this.toolsByCallKey.has(key)) {
        continue;
      }

      const metadata = {
        ...withoutModelMetadata(turn.metadata),
        "eve.step.index": event.data.stepIndex,
        "eve.tool.call_id": action.callId,
        "eve.tool.name": action.toolName,
      };
      const span = startEveSpan(turn.span, {
        event: {
          input: action.input,
          metadata,
        },
        name: action.toolName,
        spanAttributes: { type: SpanTypeAttribute.TOOL },
        startTime: eventTime(event),
      });
      safeLog(span, {
        input: action.input,
        metadata,
      });
      this.toolsByCallKey.set(key, {
        metadata,
        span,
        stepIndex: event.data.stepIndex,
        turnKey: turnKey(sessionId, event.data.turnId),
      });
    }

    if (!step) {
      turn.messages.push({
        content: null,
        role: "assistant",
        tool_calls: toolActions.map(openAIToolCallFromAction),
      });
      return;
    }

    const outputMessage =
      step.output && isObject(step.output)
        ? Reflect.get(step.output, "message")
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
      step.output = {
        message: {
          content,
          role: "assistant",
          tool_calls: [...step.toolCalls],
        },
      };
    }
  }

  private handleActionResult(
    event: Extract<EveHandleMessageStreamEvent, { type: "action.result" }>,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): void {
    if (!isToolResult(event.data.result)) {
      return;
    }

    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return;
    }

    const key = toolKey(sessionId, event.data.result.callId);
    const tool =
      this.toolsByCallKey.get(key) ??
      this.startSyntheticTool(event, ctx, event.data.result, hookMetadata);
    if (!tool) {
      return;
    }

    const failed =
      event.data.status === "failed" ||
      event.data.result.isError === true ||
      event.data.error !== undefined;
    const metadata = {
      ...tool.metadata,
      ...(event.data.status ? { "eve.action.status": event.data.status } : {}),
    };
    safeLog(tool.span, {
      ...(failed
        ? {
            error: toLoggedError(
              event.data.error?.message ?? event.data.result.output,
            ),
          }
        : {}),
      metadata,
      output: event.data.result.output,
    });

    const turn = this.turnForEvent(event, ctx);
    turn?.messages.push({
      content: event.data.result.output,
      name: event.data.result.toolName,
      role: "tool",
      tool_call_id: event.data.result.callId,
    });

    safeEnd(tool.span, eventTime(event));
    this.toolsByCallKey.delete(key);
  }

  private handleStepCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "step.completed" }>,
    ctx: unknown,
  ): void {
    const step = this.stepForEvent(event, ctx);
    if (!step) {
      return;
    }

    const metrics = metricsFromUsage(event.data.usage);
    step.metrics = { ...step.metrics, ...metrics };
    const metadata = {
      ...step.metadata,
      "eve.finish_reason": event.data.finishReason,
      ...(event.data.providerMetadata?.gateway?.generationId
        ? {
            "eve.gateway.generation_id":
              event.data.providerMetadata.gateway.generationId,
          }
        : {}),
    };

    safeLog(step.span, {
      metadata,
      metrics,
      output: step.output,
    });
    safeEnd(step.span, eventTime(event));

    const turn = this.turnForEvent(event, ctx);
    if (turn) {
      addMetrics(turn.metrics, metrics);
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
      safeEnd(step.span, eventTime(event));
    }

    const turn = this.turnForEvent(event, ctx);
    turn?.stepsByIndex.delete(event.data.stepIndex);
  }

  private handleTurnCompleted(
    event: Extract<EveHandleMessageStreamEvent, { type: "turn.completed" }>,
    ctx: unknown,
  ): void {
    const turn = this.turnForEvent(event, ctx);
    if (!turn) {
      return;
    }

    this.endOpenChildrenForTurn(turn, eventTime(event));
    safeLog(turn.span, {
      metadata: turn.metadata,
      metrics: turn.metrics,
      output: turn.output,
    });
    safeEnd(turn.span, eventTime(event));
    this.cleanupTurn(event, ctx);

    void flush().catch((error) => {
      logInstrumentationError("Eve flush", error);
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

    this.endOpenChildrenForTurn(turn, eventTime(event));
    logError(
      turn.span,
      errorFromMessage(event.data.message, event.data.code, event.data.details),
    );
    safeEnd(turn.span, eventTime(event));
    this.cleanupTurn(event, ctx);

    void flush().catch((error) => {
      logInstrumentationError("Eve flush", error);
    });
  }

  private handleSessionFailed(
    event: Extract<EveHandleMessageStreamEvent, { type: "session.failed" }>,
    ctx: unknown,
  ): void {
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
      safeEnd(turn.span, eventTime(event));
      this.turnsByKey.delete(key);
    }

    for (const [key, tool] of this.toolsByCallKey) {
      if (key.startsWith(`${sessionId}:`)) {
        safeEnd(tool.span, eventTime(event));
        this.toolsByCallKey.delete(key);
      }
    }

    this.sessionsById.delete(sessionId);

    void flush().catch((error) => {
      logInstrumentationError("Eve flush", error);
    });
  }

  private handleSessionCompleted(ctx: unknown): void {
    const sessionId = sessionIdFromContext(ctx);
    if (sessionId) {
      this.sessionsById.delete(sessionId);
    }
  }

  private ensureTurn(
    event: Extract<
      EveHandleMessageStreamEvent,
      {
        data: { readonly sequence: number; readonly turnId: string };
      }
    >,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): TurnState | undefined {
    const sessionId = sessionIdFromContext(ctx);
    if (!sessionId) {
      return undefined;
    }

    const key = turnKey(sessionId, event.data.turnId);
    const existing = this.turnsByKey.get(key);
    if (existing) {
      return existing;
    }

    const metadata = this.turnMetadata(sessionId, event, ctx, hookMetadata);
    const span = startSpan({
      event: { metadata },
      name: "eve.turn",
      spanAttributes: { type: SpanTypeAttribute.TASK },
      startTime: eventTime(event),
    });
    safeLog(span, { metadata });
    const state = {
      inputLogged: false,
      messages: [],
      metadata,
      metrics: {},
      span,
      stepsByIndex: new Map<number, StepState>(),
    };
    this.turnsByKey.set(key, state);
    return state;
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

  private startSyntheticTool(
    event: Extract<EveHandleMessageStreamEvent, { type: "action.result" }>,
    ctx: unknown,
    result: EveRuntimeToolResultActionResult,
    hookMetadata?: Record<string, unknown>,
  ): ToolState | undefined {
    const turn = this.ensureTurn(event, ctx, hookMetadata);
    const sessionId = sessionIdFromContext(ctx);
    if (!turn || !sessionId) {
      return undefined;
    }

    const metadata = {
      ...withoutModelMetadata(turn.metadata),
      "eve.step.index": event.data.stepIndex,
      "eve.tool.call_id": result.callId,
      "eve.tool.name": result.toolName,
    };
    const span = startEveSpan(turn.span, {
      event: { metadata },
      name: result.toolName,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
      startTime: eventTime(event),
    });
    safeLog(span, { metadata });
    const state = {
      metadata,
      span,
      stepIndex: event.data.stepIndex,
      turnKey: turnKey(sessionId, event.data.turnId),
    };
    this.toolsByCallKey.set(toolKey(sessionId, result.callId), state);
    return state;
  }

  private endOpenChildrenForTurn(turn: TurnState, endTime: number | undefined) {
    for (const step of turn.stepsByIndex.values()) {
      safeEnd(step.span, endTime);
    }
    turn.stepsByIndex.clear();

    for (const [key, tool] of this.toolsByCallKey) {
      if (tool.turnKey !== this.keyForTurnState(turn)) {
        continue;
      }
      safeEnd(tool.span, endTime);
      this.toolsByCallKey.delete(key);
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

  private keyForTurnState(turn: TurnState): string | undefined {
    const sessionId = turn.metadata["eve.session.id"];
    const turnId = turn.metadata["eve.turn.id"];
    return typeof sessionId === "string" && typeof turnId === "string"
      ? turnKey(sessionId, turnId)
      : undefined;
  }

  private turnMetadata(
    sessionId: string,
    event: Extract<
      EveHandleMessageStreamEvent,
      { data: { readonly sequence: number; readonly turnId: string } }
    >,
    ctx: unknown,
    hookMetadata?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...baseMetadata({
        channelKind: channelKindFromContext(ctx),
        sessionId,
        turnId: event.data.turnId,
        turnSequence: event.data.sequence,
      }),
      ...(hookMetadata ?? {}),
      ...agentMetadataFromContext(ctx),
      ...(this.sessionsById.get(sessionId)?.metadata ?? {}),
    };
  }
}

function baseMetadata(input: {
  channelKind?: string;
  sessionId: string;
  turnId: string;
  turnSequence: number;
}): Record<string, unknown> {
  return {
    "eve.channel.kind": input.channelKind ?? "unknown",
    "eve.session.id": input.sessionId,
    "eve.turn.id": input.turnId,
    "eve.turn.sequence": input.turnSequence,
  };
}

function agentMetadataFromContext(ctx: unknown): Record<string, unknown> {
  if (!isObject(ctx)) {
    return {};
  }
  const agent = Reflect.get(ctx, "agent");
  if (!isObject(agent)) {
    return {};
  }
  const name = Reflect.get(agent, "name");
  const nodeId = Reflect.get(agent, "nodeId");
  return {
    ...(typeof name === "string" ? { "eve.agent.name": name } : {}),
    ...(typeof nodeId === "string" ? { "eve.agent.node_id": nodeId } : {}),
  };
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
      "eve.model.id": normalized,
      model: normalized.slice(slashIndex + 1),
      provider: normalized.slice(0, slashIndex),
    };
  }

  return {
    "eve.model.id": normalized,
    model: normalized,
  };
}

function withoutModelMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const {
    ["eve.model.id"]: _modelId,
    model: _model,
    provider: _provider,
    ...rest
  } = metadata;
  return rest;
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

function channelKindFromContext(ctx: unknown): string | undefined {
  if (!isObject(ctx)) {
    return undefined;
  }
  const channel = Reflect.get(ctx, "channel");
  if (!isObject(channel)) {
    return undefined;
  }
  const kind = Reflect.get(channel, "kind");
  return typeof kind === "string" ? kind : undefined;
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

function openAIToolCallFromAction(action: EveRuntimeToolCallActionRequest) {
  return {
    function: {
      arguments: JSON.stringify(action.input),
      name: action.toolName,
    },
    id: action.callId,
    type: "function" as const,
  };
}

function metricsFromUsage(
  usage: Extract<
    EveHandleMessageStreamEvent,
    { type: "step.completed" }
  >["data"]["usage"],
): Record<string, number> {
  if (!usage) {
    return {};
  }

  const total =
    typeof usage.inputTokens === "number" &&
    typeof usage.outputTokens === "number"
      ? usage.inputTokens + usage.outputTokens
      : undefined;
  return {
    ...(typeof usage.inputTokens === "number"
      ? { prompt_tokens: usage.inputTokens }
      : {}),
    ...(typeof usage.outputTokens === "number"
      ? { completion_tokens: usage.outputTokens }
      : {}),
    ...(typeof total === "number" ? { tokens: total } : {}),
    ...(typeof usage.cacheReadTokens === "number"
      ? { prompt_cached_tokens: usage.cacheReadTokens }
      : {}),
    ...(typeof usage.cacheWriteTokens === "number"
      ? { prompt_cache_creation_tokens: usage.cacheWriteTokens }
      : {}),
    ...(typeof usage.costUsd === "number"
      ? { estimated_cost: usage.costUsd }
      : {}),
  };
}

function addMetrics(
  target: Record<string, number>,
  metrics: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(metrics)) {
    target[key] = (target[key] ?? 0) + value;
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

function startEveSpan(parent: Span, args: StartSpanArgs): Span {
  return withCurrent(parent, () => startSpan(args));
}

function safeLog(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    logInstrumentationError("Eve span log", error);
  }
}

function safeEnd(span: Span, endTime: number | undefined): void {
  try {
    span.end(endTime === undefined ? undefined : { endTime });
  } catch (error) {
    logInstrumentationError("Eve span end", error);
  }
}

function logInstrumentationError(label: string, error: unknown): void {
  debugLogger.warn(`Error in ${label} instrumentation:`, error);
}
