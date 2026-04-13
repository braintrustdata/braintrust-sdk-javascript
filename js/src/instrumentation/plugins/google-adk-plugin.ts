import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import {
  BRAINTRUST_CURRENT_SPAN_STORE,
  _internalGetGlobalState,
  startSpan,
  withCurrent,
} from "../../logger";
import type { CurrentSpanStore, Span } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { googleADKChannels } from "./google-adk-channels";
import type {
  GoogleADKEvent,
  GoogleADKRunAsyncParams,
  GoogleADKToolRunRequest,
  GoogleADKUsageMetadata,
  GoogleADKBaseAgent,
  GoogleADKLlmAgent,
  GoogleADKBaseTool,
} from "../../vendor-sdk-types/google-adk";

type RunnerState = {
  span: Span;
  startTime: number;
  events: GoogleADKEvent[];
  contextKey?: string;
};

type AgentState = {
  span: Span;
  startTime: number;
  events: GoogleADKEvent[];
  contextKey?: string;
  name?: string;
};

type ToolState = {
  span: Span;
  startTime: number;
};

type GoogleADKStreamChannel =
  | typeof googleADKChannels.runnerRunAsync
  | typeof googleADKChannels.agentRunAsync;

/**
 * Auto-instrumentation plugin for the Google ADK.
 *
 * This plugin subscribes to orchestrion channels for Google ADK methods
 * and creates Braintrust spans to track:
 * - Runner.runAsync — top-level agent execution (TASK span)
 * - BaseAgent.runAsync — individual agent invocations (TASK span)
 * - BaseTool/FunctionTool.runAsync — tool execution (TOOL span)
 *
 * LLM calls made through ADK are automatically captured by the existing
 * @google/genai instrumentation since ADK uses GenAI internally.
 */
export class GoogleADKPlugin extends BasePlugin {
  private activeRunnerSpans = new Map<string, Span>();
  private activeAgentSpans = new Map<string, Span>();

  protected onEnable(): void {
    this.subscribeToRunnerRunAsync();
    this.subscribeToAgentRunAsync();
    this.subscribeToToolRunAsync();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.activeRunnerSpans.clear();
    this.activeAgentSpans.clear();
  }

  private subscribeToRunnerRunAsync(): void {
    const tracingChannel =
      googleADKChannels.runnerRunAsync.tracingChannel() as IsoTracingChannel<
        ChannelMessage<typeof googleADKChannels.runnerRunAsync>
      >;
    const states = new WeakMap<object, RunnerState>();

    const createState = (
      event: ChannelMessage<typeof googleADKChannels.runnerRunAsync>,
    ): RunnerState => {
      const params = (event.arguments[0] ?? {}) as
        | GoogleADKRunAsyncParams
        | Record<string, unknown>;
      const contextKey = extractRunnerContextKey(params);

      const span = startSpan({
        name: "Google ADK Runner",
        spanAttributes: {
          type: SpanTypeAttribute.TASK,
        },
      });
      const startTime = getCurrentUnixTimestamp();

      try {
        const metadata = extractRunnerMetadata(params);
        span.log({
          input: extractRunnerInput(params),
          metadata,
        });
      } catch {
        // Silently handle extraction errors
      }

      if (contextKey) {
        this.activeRunnerSpans.set(contextKey, span);
      }

      return { span, startTime, events: [], contextKey };
    };

    const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
      tracingChannel,
      states,
      createState,
    );

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof googleADKChannels.runnerRunAsync>
    > = {
      start: (event) => {
        ensureState(states, event, () => createState(event));
      },

      end: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        const result = event.result;
        if (isAsyncIterable(result)) {
          bindAsyncIterableToCurrentSpan(result, state.span);
          patchStreamIfNeeded<GoogleADKEvent>(result, {
            onChunk: (adkEvent: GoogleADKEvent) => {
              state.events.push(adkEvent);
            },
            onComplete: () => {
              finalizeRunnerSpan(state, this.activeRunnerSpans);
              states.delete(event);
            },
            onError: (error: Error) => {
              cleanupActiveRunnerSpan(state, this.activeRunnerSpans);
              state.span.log({ error: error.message });
              state.span.end();
              states.delete(event);
            },
          });
          return;
        }

        // Non-streaming case (unlikely for runners but handle gracefully)
        try {
          state.span.log({ output: result });
        } finally {
          cleanupActiveRunnerSpan(state, this.activeRunnerSpans);
          state.span.end();
          states.delete(event);
        }
      },

      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        cleanupActiveRunnerSpan(state, this.activeRunnerSpans);
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToAgentRunAsync(): void {
    const tracingChannel =
      googleADKChannels.agentRunAsync.tracingChannel() as IsoTracingChannel<
        ChannelMessage<typeof googleADKChannels.agentRunAsync>
      >;
    const states = new WeakMap<object, AgentState>();

    const createState = (
      event: ChannelMessage<typeof googleADKChannels.agentRunAsync>,
    ): AgentState => {
      const parentContext = event.arguments[0] as
        | Record<string, unknown>
        | undefined;

      const agentName = extractAgentName(parentContext);
      const runnerParentSpan = findRunnerParentSpan(
        parentContext,
        this.activeRunnerSpans,
      );
      const contextKey = extractInvocationContextKey(parentContext);

      const span = startSpan({
        name: agentName ? `Agent: ${agentName}` : "Google ADK Agent",
        spanAttributes: {
          type: SpanTypeAttribute.TASK,
        },
        ...(runnerParentSpan
          ? {
              parentSpanIds: {
                spanId: runnerParentSpan.spanId,
                rootSpanId: runnerParentSpan.rootSpanId,
              },
            }
          : {}),
      });
      const startTime = getCurrentUnixTimestamp();

      try {
        const metadata: Record<string, unknown> = {
          provider: "google-adk",
        };
        if (agentName) {
          metadata["google_adk.agent_name"] = agentName;
        }
        const modelName = extractModelName(parentContext);
        if (modelName) {
          metadata.model = modelName;
        }

        span.log({ metadata });
      } catch {
        // Silently handle extraction errors
      }

      if (contextKey && agentName) {
        this.activeAgentSpans.set(agentContextKey(contextKey, agentName), span);
      }

      return { span, startTime, events: [], contextKey, name: agentName };
    };

    const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
      tracingChannel,
      states,
      createState,
    );

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof googleADKChannels.agentRunAsync>
    > = {
      start: (event) => {
        ensureState(states, event, () => createState(event));
      },

      end: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        const result = event.result;
        if (isAsyncIterable(result)) {
          bindAsyncIterableToCurrentSpan(result, state.span);
          patchStreamIfNeeded<GoogleADKEvent>(result, {
            onChunk: (adkEvent: GoogleADKEvent) => {
              state.events.push(adkEvent);
            },
            onComplete: () => {
              finalizeAgentSpan(state, this.activeAgentSpans);
              states.delete(event);
            },
            onError: (error: Error) => {
              cleanupActiveAgentSpan(state, this.activeAgentSpans);
              state.span.log({ error: error.message });
              state.span.end();
              states.delete(event);
            },
          });
          return;
        }

        try {
          state.span.log({ output: result });
        } finally {
          cleanupActiveAgentSpan(state, this.activeAgentSpans);
          state.span.end();
          states.delete(event);
        }
      },

      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        cleanupActiveAgentSpan(state, this.activeAgentSpans);
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToToolRunAsync(): void {
    const tracingChannel = googleADKChannels.toolRunAsync.tracingChannel();
    const states = new WeakMap<object, ToolState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof googleADKChannels.toolRunAsync>
    > = {
      start: (event) => {
        const req = (event.arguments[0] ?? {}) as GoogleADKToolRunRequest;
        const tool = event.self as GoogleADKBaseTool | undefined;

        const toolName = extractToolName(req, tool);
        const parentSpan = findToolParentSpan(
          req,
          this.activeAgentSpans,
          this.activeRunnerSpans,
        );

        const createSpan = () =>
          startSpan({
            name: toolName ? `tool: ${toolName}` : "Google ADK Tool",
            spanAttributes: {
              type: SpanTypeAttribute.TOOL,
            },
            event: {
              input: req.args,
              metadata: {
                provider: "google-adk",
                ...(toolName && { "google_adk.tool_name": toolName }),
                ...(extractToolCallId(req) && {
                  "google_adk.tool_call_id": extractToolCallId(req),
                }),
              },
            },
          });
        const span = parentSpan
          ? withCurrent(parentSpan, () => createSpan())
          : createSpan();
        const startTime = getCurrentUnixTimestamp();

        states.set(event, { span, startTime });
      },

      asyncEnd: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        try {
          const metrics: Record<string, number> = {};
          const end = getCurrentUnixTimestamp();
          metrics.start = state.startTime;
          metrics.end = end;
          metrics.duration = end - state.startTime;

          state.span.log({
            output: event.result,
            metrics: cleanMetrics(metrics),
          });
        } finally {
          state.span.end();
          states.delete(event);
        }
      },

      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }
}

function ensureState<TState>(
  states: WeakMap<object, TState>,
  event: object,
  create: () => TState,
): TState {
  const existing = states.get(event);
  if (existing) {
    return existing;
  }

  const created = create();
  states.set(event, created);
  return created;
}

function bindAsyncIterableToCurrentSpan(stream: unknown, span: Span): unknown {
  if (!isAsyncIterable(stream)) {
    return stream;
  }

  if (Object.isFrozen(stream) || Object.isSealed(stream)) {
    return stream;
  }

  if (
    "next" in stream &&
    typeof (stream as { next?: unknown }).next === "function"
  ) {
    if ("__braintrust_current_span_bound" in stream) {
      return stream;
    }

    try {
      const iterator = stream as AsyncIterator<unknown> &
        Partial<AsyncIterable<unknown>>;
      const originalNext = iterator.next.bind(iterator);
      iterator.next = (...args: [] | [undefined]) =>
        withCurrent(span, () => originalNext(...args));

      if (typeof iterator.return === "function") {
        const originalReturn = iterator.return.bind(iterator);
        iterator.return = (...args: [unknown?]) =>
          withCurrent(span, () => originalReturn(...args));
      }

      if (typeof iterator.throw === "function") {
        const originalThrow = iterator.throw.bind(iterator);
        iterator.throw = (...args: [unknown?]) =>
          withCurrent(span, () => originalThrow(...args));
      }

      Object.defineProperty(stream, "__braintrust_current_span_bound", {
        value: true,
      });
      return stream;
    } catch {
      return stream;
    }
  }

  const originalIteratorFn = stream[Symbol.asyncIterator] as (
    this: unknown,
  ) => AsyncIterator<unknown> & Partial<AsyncIterable<unknown>>;
  if (
    "__braintrust_current_span_bound" in originalIteratorFn &&
    originalIteratorFn.__braintrust_current_span_bound
  ) {
    return stream;
  }

  try {
    const patchedIteratorFn = function (this: unknown) {
      const iterator = originalIteratorFn.call(this);
      const originalNext = iterator.next.bind(iterator);

      iterator.next = (...args: [] | [undefined]) =>
        withCurrent(span, () => originalNext(...args));

      if (typeof iterator.return === "function") {
        const originalReturn = iterator.return.bind(iterator);
        iterator.return = (...args: [unknown?]) =>
          withCurrent(span, () => originalReturn(...args));
      }

      if (typeof iterator.throw === "function") {
        const originalThrow = iterator.throw.bind(iterator);
        iterator.throw = (...args: [unknown?]) =>
          withCurrent(span, () => originalThrow(...args));
      }

      return iterator;
    };

    Object.defineProperty(
      patchedIteratorFn,
      "__braintrust_current_span_bound",
      {
        value: true,
      },
    );

    (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] =
      patchedIteratorFn;
  } catch {
    return stream;
  }

  return stream;
}

function bindCurrentSpanStoreToStart<
  TChannel extends GoogleADKStreamChannel,
  TState extends { span: Span },
>(
  tracingChannel: IsoTracingChannel<ChannelMessage<TChannel>>,
  states: WeakMap<object, TState>,
  create: (event: ChannelMessage<TChannel>) => TState,
): (() => void) | undefined {
  const state = _internalGetGlobalState();
  const contextManager = state?.contextManager;
  const startChannel = tracingChannel.start as
    | ({
        bindStore?: (
          store: CurrentSpanStore,
          callback: (event: ChannelMessage<TChannel>) => unknown,
        ) => void;
        unbindStore?: (store: CurrentSpanStore) => void;
      } & object)
    | undefined;
  const currentSpanStore = contextManager
    ? (
        contextManager as {
          [BRAINTRUST_CURRENT_SPAN_STORE]?: CurrentSpanStore;
        }
      )[BRAINTRUST_CURRENT_SPAN_STORE]
    : undefined;

  if (!startChannel?.bindStore || !currentSpanStore) {
    return undefined;
  }

  startChannel.bindStore(currentSpanStore, (event) => {
    const span = ensureState(states, event as object, () =>
      create(event as ChannelMessage<TChannel>),
    ).span;
    return contextManager.wrapSpanForStore(span);
  });

  return () => {
    startChannel.unbindStore?.(currentSpanStore);
  };
}

// ---- Helper functions ----

function extractRunnerContextKey(
  paramsOrContext: GoogleADKRunAsyncParams | Record<string, unknown>,
): string | undefined {
  const directUserId =
    "userId" in paramsOrContext ? paramsOrContext.userId : undefined;
  const directSessionId =
    "sessionId" in paramsOrContext ? paramsOrContext.sessionId : undefined;

  if (typeof directUserId === "string" && typeof directSessionId === "string") {
    return `${directUserId}:${directSessionId}`;
  }

  const invocationContext = paramsOrContext as Record<string, unknown>;
  return extractInvocationContextKey(invocationContext);
}

function extractInvocationContextKey(
  parentContext: Record<string, unknown> | undefined,
): string | undefined {
  const session = parentContext?.session as Record<string, unknown> | undefined;
  const userId = session?.userId;
  const sessionId = session?.id;

  if (typeof userId !== "string" || typeof sessionId !== "string") {
    return undefined;
  }

  return `${userId}:${sessionId}`;
}

function findRunnerParentSpan(
  parentContext: Record<string, unknown> | undefined,
  activeRunnerSpans: Map<string, Span>,
): Span | undefined {
  const contextKey = extractInvocationContextKey(parentContext);
  return contextKey ? activeRunnerSpans.get(contextKey) : undefined;
}

function cleanupActiveRunnerSpan(
  state: RunnerState,
  activeRunnerSpans: Map<string, Span>,
): void {
  if (state.contextKey) {
    activeRunnerSpans.delete(state.contextKey);
  }
}

function agentContextKey(contextKey: string, agentName: string): string {
  return `${contextKey}:${agentName}`;
}

function cleanupActiveAgentSpan(
  state: AgentState,
  activeAgentSpans: Map<string, Span>,
): void {
  if (state.contextKey && state.name) {
    activeAgentSpans.delete(agentContextKey(state.contextKey, state.name));
  }
}

function extractRunnerInput(
  paramsOrContext: GoogleADKRunAsyncParams | Record<string, unknown>,
): Record<string, unknown> | undefined {
  const content =
    "newMessage" in paramsOrContext
      ? paramsOrContext.newMessage
      : (paramsOrContext as Record<string, unknown>).userContent;
  if (!content || typeof content !== "object") {
    return undefined;
  }

  const normalizedContent = content as {
    parts?: Array<{ text?: string }>;
    role?: string;
  };
  if (normalizedContent.parts && Array.isArray(normalizedContent.parts)) {
    const textParts = normalizedContent.parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text);
    if (textParts.length > 0) {
      return {
        messages: [
          {
            role: normalizedContent.role ?? "user",
            content: textParts.join(""),
          },
        ],
      };
    }
  }

  return { messages: [normalizedContent] };
}

function extractRunnerMetadata(
  paramsOrContext: GoogleADKRunAsyncParams | Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    provider: "google-adk",
  };

  const directUserId =
    "userId" in paramsOrContext ? paramsOrContext.userId : undefined;
  const directSessionId =
    "sessionId" in paramsOrContext ? paramsOrContext.sessionId : undefined;

  if (typeof directUserId === "string") {
    metadata["google_adk.user_id"] = directUserId;
  }
  if (typeof directSessionId === "string") {
    metadata["google_adk.session_id"] = directSessionId;
  }

  const session =
    "session" in paramsOrContext
      ? (paramsOrContext.session as Record<string, unknown> | undefined)
      : undefined;
  if (
    metadata["google_adk.user_id"] === undefined &&
    typeof session?.userId === "string"
  ) {
    metadata["google_adk.user_id"] = session.userId;
  }
  if (
    metadata["google_adk.session_id"] === undefined &&
    typeof session?.id === "string"
  ) {
    metadata["google_adk.session_id"] = session.id;
  }

  return metadata;
}

function extractAgentName(
  parentContext: Record<string, unknown> | undefined,
): string | undefined {
  if (!parentContext) {
    return undefined;
  }

  const agent = parentContext.agent as GoogleADKBaseAgent | undefined;
  return agent?.name;
}

function extractModelName(
  parentContext: Record<string, unknown> | undefined,
): string | undefined {
  if (!parentContext) {
    return undefined;
  }

  const agent = parentContext.agent as GoogleADKLlmAgent | undefined;
  if (!agent?.model) {
    return undefined;
  }

  if (typeof agent.model === "string") {
    return agent.model;
  }

  if (typeof agent.model === "object" && "model" in agent.model) {
    return agent.model.model;
  }

  return undefined;
}

function extractToolCallId(req: GoogleADKToolRunRequest): string | undefined {
  const toolContext = req.toolContext as Record<string, unknown> | undefined;
  return toolContext?.functionCallId as string | undefined;
}

function extractToolName(
  req: GoogleADKToolRunRequest,
  tool: GoogleADKBaseTool | undefined,
): string | undefined {
  if (typeof tool?.name === "string" && tool.name.length > 0) {
    return tool.name;
  }

  const toolContext = req.toolContext as Record<string, unknown> | undefined;
  const invocationContext = toolContext?.invocationContext as
    | Record<string, unknown>
    | undefined;
  const toolName = invocationContext?.tool?.name;
  return typeof toolName === "string" && toolName.length > 0
    ? toolName
    : undefined;
}

function extractToolAgentName(
  req: GoogleADKToolRunRequest,
): string | undefined {
  const toolContext = req.toolContext as Record<string, unknown> | undefined;
  const directName = toolContext?.agentName;
  if (typeof directName === "string" && directName.length > 0) {
    return directName;
  }

  const invocationContext = toolContext?.invocationContext as
    | Record<string, unknown>
    | undefined;
  return extractAgentName(invocationContext);
}

function findToolParentSpan(
  req: GoogleADKToolRunRequest,
  activeAgentSpans: Map<string, Span>,
  activeRunnerSpans: Map<string, Span>,
): Span | undefined {
  const toolContext = req.toolContext as Record<string, unknown> | undefined;
  const invocationContext = toolContext?.invocationContext as
    | Record<string, unknown>
    | undefined;
  const contextKey = extractInvocationContextKey(invocationContext);
  const agentName = extractToolAgentName(req);

  if (contextKey && agentName) {
    const agentSpan = activeAgentSpans.get(
      agentContextKey(contextKey, agentName),
    );
    if (agentSpan) {
      return agentSpan;
    }
  }

  return contextKey ? activeRunnerSpans.get(contextKey) : undefined;
}

function finalizeRunnerSpan(
  state: RunnerState,
  activeRunnerSpans: Map<string, Span>,
): void {
  try {
    const lastEvent = getLastNonPartialEvent(state.events);
    const metrics: Record<string, number> = {};
    const end = getCurrentUnixTimestamp();
    metrics.start = state.startTime;
    metrics.end = end;
    metrics.duration = end - state.startTime;

    const usage = aggregateUsageFromEvents(state.events);
    if (usage) {
      populateUsageMetrics(metrics, usage);
    }

    state.span.log({
      output: lastEvent ? extractEventOutput(lastEvent) : undefined,
      metrics: cleanMetrics(metrics),
    });
  } finally {
    cleanupActiveRunnerSpan(state, activeRunnerSpans);
    state.span.end();
  }
}

function finalizeAgentSpan(
  state: AgentState,
  activeAgentSpans: Map<string, Span>,
): void {
  try {
    const lastEvent = getLastNonPartialEvent(state.events);
    const metrics: Record<string, number> = {};
    const end = getCurrentUnixTimestamp();
    metrics.start = state.startTime;
    metrics.end = end;
    metrics.duration = end - state.startTime;

    state.span.log({
      output: lastEvent ? extractEventOutput(lastEvent) : undefined,
      metrics: cleanMetrics(metrics),
    });
  } finally {
    cleanupActiveAgentSpan(state, activeAgentSpans);
    state.span.end();
  }
}

function getLastNonPartialEvent(
  events: GoogleADKEvent[],
): GoogleADKEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!events[i].partial) {
      return events[i];
    }
  }
  return events.length > 0 ? events[events.length - 1] : undefined;
}

function extractEventOutput(
  event: GoogleADKEvent,
): Record<string, unknown> | undefined {
  if (!event.content) {
    return undefined;
  }

  const output: Record<string, unknown> = {};

  if (event.content.role) {
    output.role = event.content.role;
  }

  if (event.content.parts && Array.isArray(event.content.parts)) {
    const textParts = event.content.parts
      .filter((p) => p.text !== undefined && !p.thought)
      .map((p) => p.text);
    const thoughtParts = event.content.parts
      .filter((p) => p.text !== undefined && p.thought)
      .map((p) => p.text);
    const functionCalls = event.content.parts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall);

    if (textParts.length > 0) {
      output.content = textParts.join("");
    }
    if (thoughtParts.length > 0) {
      output.thought = thoughtParts.join("");
    }
    if (functionCalls.length > 0) {
      output.functionCalls = functionCalls;
    }
  }

  if (event.author) {
    output.author = event.author;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function aggregateUsageFromEvents(
  events: GoogleADKEvent[],
): GoogleADKUsageMetadata | undefined {
  let hasUsage = false;
  const aggregated: GoogleADKUsageMetadata = {};

  for (const event of events) {
    if (!event.usageMetadata) {
      continue;
    }
    hasUsage = true;
    const usage = event.usageMetadata;

    if (usage.promptTokenCount !== undefined) {
      aggregated.promptTokenCount =
        (aggregated.promptTokenCount ?? 0) + usage.promptTokenCount;
    }
    if (usage.candidatesTokenCount !== undefined) {
      aggregated.candidatesTokenCount =
        (aggregated.candidatesTokenCount ?? 0) + usage.candidatesTokenCount;
    }
    if (usage.totalTokenCount !== undefined) {
      aggregated.totalTokenCount =
        (aggregated.totalTokenCount ?? 0) + usage.totalTokenCount;
    }
    if (usage.cachedContentTokenCount !== undefined) {
      aggregated.cachedContentTokenCount =
        (aggregated.cachedContentTokenCount ?? 0) +
        usage.cachedContentTokenCount;
    }
    if (usage.thoughtsTokenCount !== undefined) {
      aggregated.thoughtsTokenCount =
        (aggregated.thoughtsTokenCount ?? 0) + usage.thoughtsTokenCount;
    }
  }

  return hasUsage ? aggregated : undefined;
}

function populateUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleADKUsageMetadata,
): void {
  if (usage.promptTokenCount !== undefined) {
    metrics.prompt_tokens = usage.promptTokenCount;
  }
  if (usage.candidatesTokenCount !== undefined) {
    metrics.completion_tokens = usage.candidatesTokenCount;
  }
  if (usage.totalTokenCount !== undefined) {
    metrics.tokens = usage.totalTokenCount;
  }
  if (usage.cachedContentTokenCount !== undefined) {
    metrics.prompt_cached_tokens = usage.cachedContentTokenCount;
  }
  if (usage.thoughtsTokenCount !== undefined) {
    metrics.completion_reasoning_tokens = usage.thoughtsTokenCount;
  }
}

function cleanMetrics(metrics: Record<string, number>): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
