import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import type { IsoChannelHandlers } from "../../isomorph";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp } from "../../util";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import {
  bindAutoInstrumentationSuppressionToStart,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { strandsAgentSDKChannels } from "./strands-agent-sdk-channels";
import type {
  StrandsAfterModelCallEvent,
  StrandsAfterNodeCallEvent,
  StrandsAfterToolCallEvent,
  StrandsAgent,
  StrandsAgentResult,
  StrandsAgentStreamEvent,
  StrandsBeforeModelCallEvent,
  StrandsBeforeNodeCallEvent,
  StrandsBeforeToolCallEvent,
  StrandsContentBlock,
  StrandsModel,
  StrandsModelMetrics,
  StrandsModelStreamUpdateEvent,
  StrandsMultiAgent,
  StrandsMultiAgentHandoffEvent,
  StrandsMultiAgentResult,
  StrandsMultiAgentStreamEvent,
  StrandsNode,
  StrandsNodeResultEvent,
  StrandsToolUse,
  StrandsUsage,
} from "../../vendor-sdk-types/strands-agent-sdk";

type AgentStreamState = {
  activeModel?: ModelSpanState;
  activeTools: Map<string, ToolSpanState>;
  finalized: boolean;
  metadata: Record<string, unknown>;
  span: Span;
  startTime: number;
};

type ModelSpanState = {
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  span: Span;
  startTime: number;
};

type ToolSpanState = {
  span: Span;
  startTime: number;
  toolUse?: StrandsToolUse;
};

type MultiAgentStreamState = {
  activeNodes: Map<string, NodeSpanState>;
  finalized: boolean;
  handoffs: Array<{ source?: string; targets?: string[] }>;
  metadata: Record<string, unknown>;
  operation: "Graph.stream" | "Swarm.stream";
  orchestrator?: StrandsMultiAgent;
  span: Span;
  startTime: number;
};

type NodeSpanState = {
  child?: object;
  span: Span;
  startTime: number;
};

type MultiAgentStreamChannel =
  | typeof strandsAgentSDKChannels.graphStream
  | typeof strandsAgentSDKChannels.swarmStream;

export class StrandsAgentSDKPlugin extends BasePlugin {
  private readonly activeChildParents = new WeakMap<object, Span[]>();

  protected onEnable(): void {
    this.subscribeToAgentStream();
    this.subscribeToMultiAgentStream(
      strandsAgentSDKChannels.graphStream,
      "Graph.stream",
    );
    this.subscribeToMultiAgentStream(
      strandsAgentSDKChannels.swarmStream,
      "Swarm.stream",
    );
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToAgentStream(): void {
    const channel = strandsAgentSDKChannels.agentStream.tracingChannel();
    const states = new WeakMap<object, AgentStreamState>();
    const unbindAutoInstrumentationSuppression =
      bindAutoInstrumentationSuppressionToStart(channel);

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof strandsAgentSDKChannels.agentStream>
    > = {
      start: (event) => {
        const state = startAgentStream(event, this.activeChildParents);
        if (state) {
          states.set(event, state);
        }
      },
      end: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        const result = event.result;
        if (isAsyncIterable(result)) {
          patchStreamIfNeeded<StrandsAgentStreamEvent>(result, {
            aroundNext: (callback) =>
              runWithAutoInstrumentationSuppressed(callback),
            onChunk: (chunk) => handleAgentStreamEvent(state, chunk),
            onComplete: () => {
              finalizeAgentStream(state);
              states.delete(event);
            },
            onError: (error) => {
              finalizeAgentStream(state, error);
              states.delete(event);
            },
          });
          return;
        }

        finalizeAgentStream(state, undefined, result);
        states.delete(event);
      },
      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        finalizeAgentStream(state, event.error);
        states.delete(event);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindAutoInstrumentationSuppression?.();
      channel.unsubscribe(handlers);
    });
  }

  private subscribeToMultiAgentStream(
    channel: MultiAgentStreamChannel,
    operation: MultiAgentStreamState["operation"],
  ): void {
    const tracingChannel = channel.tracingChannel();
    const states = new WeakMap<object, MultiAgentStreamState>();
    const unbindAutoInstrumentationSuppression =
      bindAutoInstrumentationSuppressionToStart(tracingChannel);

    const handlers: IsoChannelHandlers<ChannelMessage<typeof channel>> = {
      start: (event) => {
        const state = startMultiAgentStream(event, operation);
        if (state) {
          states.set(event, state);
        }
      },
      end: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        const result = event.result;
        if (isAsyncIterable(result)) {
          patchStreamIfNeeded<StrandsMultiAgentStreamEvent>(result, {
            aroundNext: (callback) =>
              runWithAutoInstrumentationSuppressed(callback),
            onChunk: (chunk) =>
              handleMultiAgentStreamEvent(
                state,
                chunk,
                this.activeChildParents,
              ),
            onComplete: () => {
              finalizeMultiAgentStream(state, this.activeChildParents);
              states.delete(event);
            },
            onError: (error) => {
              finalizeMultiAgentStream(state, this.activeChildParents, error);
              states.delete(event);
            },
          });
          return;
        }

        finalizeMultiAgentStream(
          state,
          this.activeChildParents,
          undefined,
          result,
        );
        states.delete(event);
      },
      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        finalizeMultiAgentStream(state, this.activeChildParents, event.error);
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindAutoInstrumentationSuppression?.();
      tracingChannel.unsubscribe(handlers);
    });
  }
}

function startAgentStream(
  event: ChannelMessage<typeof strandsAgentSDKChannels.agentStream>,
  activeChildParents: WeakMap<object, Span[]>,
): AgentStreamState | undefined {
  const agent = extractAgent(event);
  const model = agent?.model;
  const metadata = {
    ...extractAgentMetadata(agent),
    ...extractModelMetadata(model),
    "strands.operation": "Agent.stream",
    provider: extractProvider(model),
    ...(event.moduleVersion
      ? { "strands_agent_sdk.version": event.moduleVersion }
      : {}),
  };
  const parentSpan = agent
    ? peekChildParent(activeChildParents, agent)
    : undefined;
  const span = parentSpan
    ? withCurrent(parentSpan, () =>
        startSpan({
          event: {
            input: normalizeSerializable(event.arguments[0]),
            metadata,
          },
          name: formatAgentSpanName(agent),
          spanAttributes: { type: SpanTypeAttribute.TASK },
        }),
      )
    : startSpan({
        event: {
          input: normalizeSerializable(event.arguments[0]),
          metadata,
        },
        name: formatAgentSpanName(agent),
        spanAttributes: { type: SpanTypeAttribute.TASK },
      });

  return {
    activeTools: new Map(),
    finalized: false,
    metadata,
    span,
    startTime: getCurrentUnixTimestamp(),
  };
}

function startMultiAgentStream(
  event: ChannelMessage<MultiAgentStreamChannel>,
  operation: MultiAgentStreamState["operation"],
): MultiAgentStreamState {
  const orchestrator = extractOrchestrator(event);
  const metadata = {
    "strands.operation": operation,
    provider: "strands",
    ...(orchestrator?.id ? { "strands.orchestrator.id": orchestrator.id } : {}),
    ...(event.moduleVersion
      ? { "strands_agent_sdk.version": event.moduleVersion }
      : {}),
  };
  const span = startSpan({
    event: {
      input: normalizeSerializable(event.arguments[0]),
      metadata,
    },
    name: operation === "Graph.stream" ? "Strands Graph" : "Strands Swarm",
    spanAttributes: { type: SpanTypeAttribute.TASK },
  });

  return {
    activeNodes: new Map(),
    finalized: false,
    handoffs: [],
    metadata,
    operation,
    orchestrator,
    span,
    startTime: getCurrentUnixTimestamp(),
  };
}

function handleAgentStreamEvent(
  state: AgentStreamState,
  event: StrandsAgentStreamEvent,
): void {
  try {
    switch (event.type) {
      case "beforeModelCallEvent":
        startModelSpan(state, event);
        break;
      case "modelStreamUpdateEvent":
        collectModelStreamMetadata(state, event);
        break;
      case "afterModelCallEvent":
        finalizeModelSpan(state, event);
        break;
      case "beforeToolCallEvent":
        startToolSpan(state, event);
        break;
      case "afterToolCallEvent":
        finalizeToolSpan(state, event);
        break;
      case "toolResultEvent":
        finalizeToolSpanFromResult(state, event.result);
        break;
      case "agentResultEvent":
        safeLog(state.span, {
          metadata: {
            ...state.metadata,
            ...extractAgentResultMetadata(event.result),
          },
          metrics: {
            ...buildDurationMetrics(state.startTime),
            ...parseUsage(event.result?.metrics?.accumulatedUsage),
          },
          output: extractAgentResultOutput(event.result),
        });
        break;
      default:
        break;
    }
  } catch (error) {
    logInstrumentationError("Strands Agent SDK event", error);
  }
}

function handleMultiAgentStreamEvent(
  state: MultiAgentStreamState,
  event: StrandsMultiAgentStreamEvent,
  activeChildParents: WeakMap<object, Span[]>,
): void {
  try {
    switch (event.type) {
      case "beforeNodeCallEvent":
        startNodeSpan(state, event, activeChildParents);
        break;
      case "nodeResultEvent":
        logNodeResult(state, event);
        break;
      case "afterNodeCallEvent":
        finalizeNodeSpan(state, event, activeChildParents);
        break;
      case "multiAgentHandoffEvent":
        collectHandoff(state, event);
        break;
      case "multiAgentResultEvent":
        safeLog(state.span, {
          metadata: {
            ...state.metadata,
            ...(state.handoffs.length > 0
              ? { "strands.handoffs": state.handoffs }
              : {}),
            ...extractMultiAgentResultMetadata(event.result),
          },
          metrics: {
            ...buildDurationMetrics(state.startTime),
            ...parseUsage(event.result?.usage),
          },
          output: extractMultiAgentResultOutput(event.result),
        });
        break;
      default:
        break;
    }
  } catch (error) {
    logInstrumentationError("Strands Agent SDK multi-agent event", error);
  }
}

function startModelSpan(
  state: AgentStreamState,
  event: StrandsBeforeModelCallEvent,
): void {
  if (state.activeModel) {
    finalizeModelSpan(state);
  }

  const model = event.model ?? event.agent?.model;
  const metadata = {
    ...extractModelMetadata(model),
    "strands.operation": "model.stream",
    ...(typeof event.projectedInputTokens === "number"
      ? { "strands.projected_input_tokens": event.projectedInputTokens }
      : {}),
    provider: extractProvider(model),
  };
  const span = withCurrent(state.span, () =>
    startSpan({
      event: {
        input: normalizeMessages(event.agent?.messages),
        metadata,
      },
      name: formatModelSpanName(model),
      spanAttributes: { type: SpanTypeAttribute.LLM },
    }),
  );

  state.activeModel = {
    metadata,
    metrics:
      typeof event.projectedInputTokens === "number"
        ? { prompt_tokens: event.projectedInputTokens }
        : {},
    span,
    startTime: getCurrentUnixTimestamp(),
  };
}

function collectModelStreamMetadata(
  state: AgentStreamState,
  event: StrandsModelStreamUpdateEvent,
): void {
  if (!state.activeModel || event.event?.type !== "modelMetadataEvent") {
    return;
  }
  Object.assign(state.activeModel.metrics, parseUsage(event.event.usage));
  Object.assign(
    state.activeModel.metrics,
    parseModelMetrics(event.event.metrics),
  );
}

function finalizeModelSpan(
  state: AgentStreamState,
  event?: StrandsAfterModelCallEvent,
): void {
  const modelState = state.activeModel;
  if (!modelState) {
    return;
  }
  state.activeModel = undefined;

  const metadata = {
    ...modelState.metadata,
    ...(event?.attemptCount
      ? { "strands.model.attempt": event.attemptCount }
      : {}),
    ...(event?.stopData?.stopReason
      ? { "strands.stop_reason": event.stopData.stopReason }
      : {}),
  };
  const metrics = {
    ...buildDurationMetrics(modelState.startTime),
    ...modelState.metrics,
  };

  safeLog(modelState.span, {
    ...(event?.error ? { error: stringifyUnknown(event.error) } : {}),
    metadata,
    metrics: cleanMetrics(metrics),
    output: normalizeSerializable(event?.stopData?.message),
  });
  modelState.span.end();
}

function startToolSpan(
  state: AgentStreamState,
  event: StrandsBeforeToolCallEvent,
): void {
  const toolUse = event.toolUse;
  const key = toolKey(toolUse);
  if (state.activeTools.has(key)) {
    finalizeToolSpanState(state.activeTools.get(key));
    state.activeTools.delete(key);
  }

  const name = extractToolName(toolUse, event.tool);
  const span = withCurrent(state.span, () =>
    startSpan({
      event: {
        input: normalizeSerializable(toolUse?.input),
        metadata: {
          "gen_ai.tool.call.id": toolUse?.toolUseId,
          "gen_ai.tool.name": name,
          "strands.operation": "tool.call",
          "strands.tool.name": name,
          provider: "strands",
        },
      },
      name: `tool: ${name}`,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    }),
  );

  state.activeTools.set(key, {
    span,
    startTime: getCurrentUnixTimestamp(),
    toolUse,
  });
}

function finalizeToolSpan(
  state: AgentStreamState,
  event: StrandsAfterToolCallEvent,
): void {
  const key = toolKey(event.toolUse);
  const toolState = state.activeTools.get(key);
  if (!toolState) {
    return;
  }
  state.activeTools.delete(key);

  finalizeToolSpanState(toolState, {
    error: event.error,
    result: event.result,
    toolUse: event.toolUse,
  });
}

function finalizeToolSpanFromResult(
  state: AgentStreamState,
  result: unknown,
): void {
  if (!isObject(result)) {
    return;
  }
  const toolUseId = result.toolUseId;
  if (typeof toolUseId !== "string") {
    return;
  }
  const toolState = state.activeTools.get(toolUseId);
  if (!toolState) {
    return;
  }
  state.activeTools.delete(toolUseId);
  finalizeToolSpanState(toolState, { result });
}

function finalizeToolSpanState(
  toolState: ToolSpanState | undefined,
  data: {
    error?: unknown;
    result?: unknown;
    toolUse?: StrandsToolUse;
  } = {},
): void {
  if (!toolState) {
    return;
  }
  const result = normalizeSerializable(data.result);
  safeLog(toolState.span, {
    ...(data.error ? { error: stringifyUnknown(data.error) } : {}),
    metadata: {
      ...((data.toolUse?.toolUseId ?? toolState.toolUse?.toolUseId)
        ? {
            "gen_ai.tool.call.id":
              data.toolUse?.toolUseId ?? toolState.toolUse?.toolUseId,
          }
        : {}),
      ...(extractToolName(data.toolUse ?? toolState.toolUse)
        ? {
            "gen_ai.tool.name": extractToolName(
              data.toolUse ?? toolState.toolUse,
            ),
          }
        : {}),
      ...(isObject(result) && typeof result.status === "string"
        ? { "strands.tool.status": result.status }
        : {}),
    },
    metrics: buildDurationMetrics(toolState.startTime),
    output: result,
  });
  toolState.span.end();
}

function startNodeSpan(
  state: MultiAgentStreamState,
  event: StrandsBeforeNodeCallEvent,
  activeChildParents: WeakMap<object, Span[]>,
): void {
  const nodeId = event.nodeId ?? "unknown";
  const node = findNode(event.orchestrator ?? state.orchestrator, nodeId);
  const child = extractNodeChild(node);
  const metadata = {
    "strands.node.id": nodeId,
    ...(node?.type ? { "strands.node.type": node.type } : {}),
    "strands.operation": "node.call",
    provider: "strands",
  };
  const span = withCurrent(state.span, () =>
    startSpan({
      event: { metadata },
      name: `node: ${nodeId}`,
      spanAttributes: { type: SpanTypeAttribute.TASK },
    }),
  );
  const nodeState = {
    ...(child ? { child } : {}),
    span,
    startTime: getCurrentUnixTimestamp(),
  };

  state.activeNodes.set(nodeId, nodeState);
  if (child) {
    pushChildParent(activeChildParents, child, span);
  }
}

function logNodeResult(
  state: MultiAgentStreamState,
  event: StrandsNodeResultEvent,
): void {
  const nodeId = event.nodeId ?? event.result?.nodeId ?? "unknown";
  const nodeState = state.activeNodes.get(nodeId);
  if (!nodeState) {
    return;
  }

  safeLog(nodeState.span, {
    ...(event.result?.error
      ? { error: stringifyUnknown(event.result.error) }
      : {}),
    metadata: {
      ...(event.nodeType ? { "strands.node.type": event.nodeType } : {}),
      ...(event.result?.status
        ? { "strands.node.status": event.result.status }
        : {}),
    },
    metrics: {
      ...buildDurationMetrics(nodeState.startTime),
      ...(typeof event.result?.duration === "number"
        ? { "strands.node.duration_ms": event.result.duration }
        : {}),
      ...parseUsage(event.result?.usage),
    },
    output: extractNodeResultOutput(event.result),
  });
}

function finalizeNodeSpan(
  state: MultiAgentStreamState,
  event: StrandsAfterNodeCallEvent,
  activeChildParents: WeakMap<object, Span[]>,
): void {
  const nodeId = event.nodeId ?? "unknown";
  const nodeState = state.activeNodes.get(nodeId);
  if (!nodeState) {
    return;
  }
  state.activeNodes.delete(nodeId);
  if (event.error) {
    safeLog(nodeState.span, { error: stringifyUnknown(event.error) });
  }
  nodeState.span.end();
  if (nodeState.child) {
    popChildParent(activeChildParents, nodeState.child, nodeState.span);
  }
}

function collectHandoff(
  state: MultiAgentStreamState,
  event: StrandsMultiAgentHandoffEvent,
): void {
  state.handoffs.push({
    ...(event.source ? { source: event.source } : {}),
    ...(Array.isArray(event.targets) ? { targets: event.targets } : {}),
  });
}

function finalizeAgentStream(
  state: AgentStreamState,
  error?: unknown,
  output?: unknown,
): void {
  if (state.finalized) {
    return;
  }
  state.finalized = true;

  finalizeModelSpan(state);
  for (const toolState of state.activeTools.values()) {
    finalizeToolSpanState(toolState);
  }
  state.activeTools.clear();

  safeLog(state.span, {
    ...(error ? { error: stringifyUnknown(error) } : {}),
    metrics: buildDurationMetrics(state.startTime),
    ...(output !== undefined ? { output: normalizeSerializable(output) } : {}),
  });
  state.span.end();
}

function finalizeMultiAgentStream(
  state: MultiAgentStreamState,
  activeChildParents: WeakMap<object, Span[]>,
  error?: unknown,
  output?: unknown,
): void {
  if (state.finalized) {
    return;
  }
  state.finalized = true;

  for (const nodeState of state.activeNodes.values()) {
    if (nodeState.child) {
      popChildParent(activeChildParents, nodeState.child, nodeState.span);
    }
    nodeState.span.end();
  }
  state.activeNodes.clear();

  safeLog(state.span, {
    ...(error ? { error: stringifyUnknown(error) } : {}),
    metrics: buildDurationMetrics(state.startTime),
    ...(output !== undefined ? { output: normalizeSerializable(output) } : {}),
  });
  state.span.end();
}

function extractAgent(
  event: ChannelMessage<typeof strandsAgentSDKChannels.agentStream>,
): StrandsAgent | undefined {
  const candidate = event.agent ?? event.self;
  return isObject(candidate) && typeof candidate.stream === "function"
    ? (candidate as StrandsAgent)
    : undefined;
}

function extractOrchestrator(
  event: ChannelMessage<MultiAgentStreamChannel>,
): StrandsMultiAgent | undefined {
  const candidate = event.orchestrator ?? event.self;
  return isObject(candidate) && typeof candidate.stream === "function"
    ? (candidate as StrandsMultiAgent)
    : undefined;
}

function extractAgentMetadata(
  agent: StrandsAgent | undefined,
): Record<string, unknown> {
  return {
    ...(agent?.id ? { "strands.agent.id": agent.id } : {}),
    ...(agent?.name ? { "strands.agent.name": agent.name } : {}),
    ...(agent?.description
      ? { "strands.agent.description": agent.description }
      : {}),
  };
}

function extractModelMetadata(
  model: StrandsModel | undefined,
): Record<string, unknown> {
  const config = getModelConfig(model);
  const modelName = extractModelName(model);
  return {
    ...(modelName ? { model: modelName } : {}),
    ...(config?.api ? { "strands.model.api": config.api } : {}),
    ...(model?.stateful !== undefined
      ? { "strands.model.stateful": model.stateful }
      : {}),
  };
}

function extractAgentResultMetadata(
  result: StrandsAgentResult | undefined,
): Record<string, unknown> {
  return {
    ...(result?.stopReason ? { "strands.stop_reason": result.stopReason } : {}),
    ...(typeof result?.metrics?.latestContextSize === "number"
      ? { "strands.context_size": result.metrics.latestContextSize }
      : {}),
    ...(typeof result?.metrics?.projectedContextSize === "number"
      ? {
          "strands.projected_context_size": result.metrics.projectedContextSize,
        }
      : {}),
  };
}

function extractMultiAgentResultMetadata(
  result: StrandsMultiAgentResult | undefined,
): Record<string, unknown> {
  return {
    ...(result?.status ? { "strands.status": result.status } : {}),
    ...(typeof result?.duration === "number"
      ? { "strands.duration_ms": result.duration }
      : {}),
  };
}

function extractProvider(model: StrandsModel | undefined): string {
  const config = getModelConfig(model);
  if (typeof config?.provider === "string") {
    return config.provider;
  }
  const constructorName = getConstructorName(model).toLowerCase();
  if (constructorName.includes("openai")) {
    return "openai";
  }
  if (constructorName.includes("anthropic")) {
    return "anthropic";
  }
  if (constructorName.includes("bedrock")) {
    return "bedrock";
  }
  if (constructorName.includes("google")) {
    return "google";
  }
  if (constructorName.includes("vercel")) {
    return "vercel";
  }
  return "strands";
}

function extractModelName(model: StrandsModel | undefined): string | undefined {
  const config = getModelConfig(model);
  if (typeof model?.modelId === "string") {
    return model.modelId;
  }
  if (typeof config?.modelId === "string") {
    return config.modelId;
  }
  if (typeof config?.model === "string") {
    return config.model;
  }
  return undefined;
}

function getModelConfig(model: StrandsModel | undefined) {
  if (!model || typeof model.getConfig !== "function") {
    return undefined;
  }
  try {
    return model.getConfig();
  } catch (error) {
    logInstrumentationError("Strands Agent SDK model config", error);
    return undefined;
  }
}

function formatAgentSpanName(agent: StrandsAgent | undefined): string {
  return agent?.name ? `Agent: ${agent.name}` : "Strands Agent";
}

function formatModelSpanName(model: StrandsModel | undefined): string {
  const modelName = extractModelName(model);
  return modelName ? `Strands model: ${modelName}` : "Strands model";
}

function normalizeMessages(messages: StrandsMessage[] | undefined): unknown {
  return Array.isArray(messages)
    ? messages.map((message) => normalizeSerializable(message))
    : undefined;
}

function normalizeSerializable(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }
  const toJSON = value.toJSON;
  if (typeof toJSON === "function") {
    try {
      return toJSON.call(value);
    } catch {
      return value;
    }
  }
  return value;
}

function extractAgentResultOutput(result: StrandsAgentResult | undefined) {
  if (!result) {
    return undefined;
  }
  if (result.structuredOutput !== undefined) {
    return normalizeSerializable(result.structuredOutput);
  }
  if (result.lastMessage) {
    return normalizeSerializable(result.lastMessage);
  }
  return normalizeSerializable(result);
}

function extractMultiAgentResultOutput(
  result: StrandsMultiAgentResult | undefined,
) {
  if (!result) {
    return undefined;
  }
  if (Array.isArray(result.content)) {
    return normalizeContentBlocks(result.content);
  }
  return normalizeSerializable(result);
}

function extractNodeResultOutput(result: StrandsNodeResultEvent["result"]) {
  if (!result) {
    return undefined;
  }
  if (result.structuredOutput !== undefined) {
    return normalizeSerializable(result.structuredOutput);
  }
  if (Array.isArray(result.content)) {
    return normalizeContentBlocks(result.content);
  }
  return normalizeSerializable(result);
}

function normalizeContentBlocks(blocks: StrandsContentBlock[]): unknown {
  const text = blocks
    .map((block) => (typeof block.text === "string" ? block.text : undefined))
    .filter((part): part is string => Boolean(part))
    .join("");
  return text.length > 0
    ? text
    : blocks.map((block) => normalizeSerializable(block));
}

function parseUsage(usage: StrandsUsage | undefined): Record<string, number> {
  const metrics: Record<string, number> = {};
  assignMetric(metrics, "prompt_tokens", usage?.inputTokens);
  assignMetric(metrics, "completion_tokens", usage?.outputTokens);
  assignMetric(metrics, "tokens", usage?.totalTokens);
  assignMetric(metrics, "prompt_cached_tokens", usage?.cacheReadInputTokens);
  assignMetric(
    metrics,
    "prompt_cache_creation_tokens",
    usage?.cacheWriteInputTokens,
  );
  return metrics;
}

function parseModelMetrics(
  metrics: StrandsModelMetrics | undefined,
): Record<string, number> {
  const parsed: Record<string, number> = {};
  assignMetric(parsed, "strands.latency_ms", metrics?.latencyMs);
  assignMetric(
    parsed,
    "strands.time_to_first_byte_ms",
    metrics?.timeToFirstByteMs,
  );
  return parsed;
}

function assignMetric(
  metrics: Record<string, number>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    metrics[key] = value;
  }
}

function buildDurationMetrics(startTime: number): Record<string, number> {
  const end = getCurrentUnixTimestamp();
  return {
    duration: end - startTime,
    end,
    start: startTime,
  };
}

function cleanMetrics(metrics: Record<string, number>): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (Number.isFinite(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function extractToolName(
  toolUse: StrandsToolUse | undefined,
  tool?: { name?: string },
): string {
  return toolUse?.name ?? tool?.name ?? "unknown";
}

function toolKey(toolUse: StrandsToolUse | undefined): string {
  return toolUse?.toolUseId ?? toolUse?.name ?? "unknown";
}

function findNode(
  orchestrator: StrandsMultiAgent | undefined,
  nodeId: string,
): StrandsNode | undefined {
  try {
    return orchestrator?.nodes?.get(nodeId);
  } catch {
    return undefined;
  }
}

function extractNodeChild(node: StrandsNode | undefined): object | undefined {
  const child = node?.agent ?? node?.orchestrator;
  return isObject(child) ? child : undefined;
}

function pushChildParent(
  activeChildParents: WeakMap<object, Span[]>,
  child: object,
  span: Span,
): void {
  activeChildParents.set(child, [
    ...(activeChildParents.get(child) ?? []),
    span,
  ]);
}

function popChildParent(
  activeChildParents: WeakMap<object, Span[]>,
  child: object,
  span: Span,
): void {
  const stack = activeChildParents.get(child);
  if (!stack) {
    return;
  }
  const index = stack.lastIndexOf(span);
  if (index >= 0) {
    stack.splice(index, 1);
  }
  if (stack.length === 0) {
    activeChildParents.delete(child);
  } else {
    activeChildParents.set(child, stack);
  }
}

function peekChildParent(
  activeChildParents: WeakMap<object, Span[]>,
  child: object,
): Span | undefined {
  const stack = activeChildParents.get(child);
  return stack?.[stack.length - 1];
}

function getConstructorName(value: unknown): string {
  if (!isObject(value)) {
    return "";
  }
  const constructor = value.constructor;
  return typeof constructor === "function" &&
    typeof constructor.name === "string"
    ? constructor.name
    : "";
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeLog(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    logInstrumentationError("Strands Agent SDK span log", error);
  }
}

function logInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`${context}:`, error);
}
