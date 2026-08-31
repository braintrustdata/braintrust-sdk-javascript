import { BasePlugin, toLoggedError } from "../core";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import { debugLogger } from "../../debug-logger";
import {
  Attachment,
  BaseAttachment,
  startSpan as startBaseSpan,
  withCurrent,
} from "../../logger";
import type { Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { LRUCache } from "../../lru-cache";
import { getCurrentUnixTimestamp } from "../../util";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { convertDataToBlob } from "../../wrappers/attachment-utils";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
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
  StrandsMediaBlock,
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
  attachmentCache: StrandsAttachmentCache;
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

type ActiveChildParents = WeakMap<object, Set<Span>>;

const MAX_STRANDS_STRING_ATTACHMENT_CACHE_ENTRIES = 32;

type StrandsAttachmentCache = {
  objects: WeakMap<object, Map<string, Attachment>>;
  strings: LRUCache<string, Map<string, Attachment>>;
};

export class StrandsAgentSDKPlugin extends BasePlugin {
  private readonly activeChildParents: ActiveChildParents = new WeakMap();

  protected onEnable(): void {
    this.interceptAgentStream();
    this.interceptMultiAgentStream(
      strandsAgentSDKChannels.graphStream,
      "Graph.stream",
    );
    this.interceptMultiAgentStream(
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

  private interceptAgentStream(): void {
    this.unsubscribers.push(
      strandsAgentSDKChannels.agentStream.intercept(
        (target, thisArg, args, additional) =>
          instrumentStrandsStreamInvocation<
            AgentStreamState,
            StrandsAgentStreamEvent,
            ReturnType<typeof target>
          >({
            finalize: finalizeAgentStream,
            handleChunk: handleAgentStreamEvent,
            invoke: () => Reflect.apply(target, thisArg, args),
            name: "Strands Agent SDK",
            start: () =>
              startAgentStream(
                args[0],
                extractAgent(additional.agent, thisArg),
                this.activeChildParents,
              ),
          }),
      ),
    );
  }

  private interceptMultiAgentStream(
    channel: MultiAgentStreamChannel,
    operation: MultiAgentStreamState["operation"],
  ): void {
    this.unsubscribers.push(
      channel.intercept((target, thisArg, args, additional) =>
        instrumentStrandsStreamInvocation<
          MultiAgentStreamState,
          StrandsMultiAgentStreamEvent,
          ReturnType<typeof target>
        >({
          finalize: (state, error, output) =>
            finalizeMultiAgentStream(
              state,
              this.activeChildParents,
              error,
              output,
            ),
          handleChunk: (state, chunk) =>
            handleMultiAgentStreamEvent(state, chunk, this.activeChildParents),
          invoke: () => Reflect.apply(target, thisArg, args),
          name: "Strands multi-agent",
          start: () =>
            startMultiAgentStream(
              args[0],
              extractOrchestrator(additional.orchestrator, thisArg),
              operation,
              this.activeChildParents,
            ),
        }),
      ),
    );
  }
}

function instrumentStrandsStreamInvocation<TState, TChunk, TResult>(options: {
  finalize: (state: TState, error?: unknown, output?: unknown) => void;
  handleChunk: (state: TState, chunk: TChunk) => void;
  invoke: () => TResult;
  name: string;
  start: () => TState;
}): TResult {
  let state: TState | undefined;
  try {
    state = options.start();
  } catch (error) {
    debugLogger.error(`Error starting ${options.name} instrumentation:`, error);
  }

  let result: TResult;
  try {
    result = runWithAutoInstrumentationSuppressed(options.invoke);
  } catch (error) {
    if (state) {
      try {
        options.finalize(state, error);
      } catch (instrumentationError) {
        debugLogger.error(
          `Error handling ${options.name} instrumentation failure:`,
          instrumentationError,
        );
      }
    }
    throw error;
  }

  if (state) {
    try {
      if (isAsyncIterable(result)) {
        patchStreamIfNeeded<TChunk>(result, {
          aroundNext: (callback) =>
            runWithAutoInstrumentationSuppressed(callback),
          onChunk: (chunk) => options.handleChunk(state, chunk),
          onComplete: () => options.finalize(state),
          onError: (error) => options.finalize(state, error),
        });
      } else {
        options.finalize(state, undefined, result);
      }
    } catch (error) {
      debugLogger.error(
        `Error finalizing ${options.name} instrumentation:`,
        error,
      );
    }
  }
  return result;
}

function startAgentStream(
  input: unknown,
  agent: StrandsAgent | undefined,
  activeChildParents: ActiveChildParents,
): AgentStreamState {
  const model = agent?.model;
  const metadata = {
    ...extractAgentMetadata(agent),
    ...extractModelMetadata(model),
    "strands.operation": "Agent.stream",
    provider: extractProvider(model),
  };
  const parentSpan = agent
    ? getOnlyChildParent(activeChildParents, agent)
    : undefined;
  const attachmentCache = createStrandsAttachmentCache();
  const processedInput = processStrandsInputAttachments(input, attachmentCache);
  const span = parentSpan
    ? withCurrent(parentSpan, () =>
        startBaseSpan(
          withSpanInstrumentationName(
            {
              event: {
                input: processedInput,
                metadata,
              },
              name: formatAgentSpanName(agent),
              spanAttributes: { type: SpanTypeAttribute.TASK },
            },
            INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
          ),
        ),
      )
    : startBaseSpan(
        withSpanInstrumentationName(
          {
            event: {
              input: processedInput,
              metadata,
            },
            name: formatAgentSpanName(agent),
            spanAttributes: { type: SpanTypeAttribute.TASK },
          },
          INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
        ),
      );

  return {
    activeTools: new Map(),
    attachmentCache,
    finalized: false,
    metadata,
    span,
    startTime: getCurrentUnixTimestamp(),
  };
}

function startMultiAgentStream(
  input: unknown,
  orchestrator: StrandsMultiAgent | undefined,
  operation: MultiAgentStreamState["operation"],
  activeChildParents: ActiveChildParents,
): MultiAgentStreamState {
  const metadata = {
    "strands.operation": operation,
    provider: "strands",
    ...(orchestrator?.id ? { "strands.orchestrator.id": orchestrator.id } : {}),
  };
  const parentSpan = orchestrator
    ? getOnlyChildParent(activeChildParents, orchestrator)
    : undefined;
  const processedInput = processStrandsInputAttachments(input);
  const span = parentSpan
    ? withCurrent(parentSpan, () =>
        startBaseSpan(
          withSpanInstrumentationName(
            {
              event: {
                input: processedInput,
                metadata,
              },
              name:
                operation === "Graph.stream"
                  ? "Strands Graph"
                  : "Strands Swarm",
              spanAttributes: { type: SpanTypeAttribute.TASK },
            },
            INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
          ),
        ),
      )
    : startBaseSpan(
        withSpanInstrumentationName(
          {
            event: {
              input: processedInput,
              metadata,
            },
            name:
              operation === "Graph.stream" ? "Strands Graph" : "Strands Swarm",
            spanAttributes: { type: SpanTypeAttribute.TASK },
          },
          INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
        ),
      );

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
  activeChildParents: ActiveChildParents,
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

function buildModelSpanInput(
  event: StrandsBeforeModelCallEvent,
  attachmentCache: StrandsAttachmentCache,
): unknown {
  const systemPrompt =
    typeof event.agent?.systemPrompt === "string" &&
    event.agent.systemPrompt.length > 0
      ? event.agent.systemPrompt
      : undefined;
  const processedMessages = Array.isArray(event.agent?.messages)
    ? processStrandsInputAttachments(event.agent.messages, attachmentCache)
    : undefined;

  if (!systemPrompt) {
    return processedMessages;
  }

  const systemMessage = { role: "system", content: systemPrompt };
  return Array.isArray(processedMessages)
    ? [systemMessage, ...processedMessages]
    : [systemMessage];
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
    startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: buildModelSpanInput(event, state.attachmentCache),
            metadata,
          },
          name: formatModelSpanName(model),
          spanAttributes: { type: SpanTypeAttribute.LLM },
        },
        INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
      ),
    ),
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
    ...(event?.error ? { error: toLoggedError(event.error) } : {}),
    metadata,
    metrics: cleanMetrics(metrics),
    output: event?.stopData?.message,
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
    startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: toolUse?.input,
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
        },
        INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
      ),
    ),
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
  const result = data.result;
  safeLog(toolState.span, {
    ...(data.error ? { error: toLoggedError(data.error) } : {}),
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
  activeChildParents: ActiveChildParents,
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
    startBaseSpan(
      withSpanInstrumentationName(
        {
          event: { metadata },
          name: `node: ${nodeId}`,
          spanAttributes: { type: SpanTypeAttribute.TASK },
        },
        INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
      ),
    ),
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
      ? { error: toLoggedError(event.result.error) }
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
  activeChildParents: ActiveChildParents,
): void {
  const nodeId = event.nodeId ?? "unknown";
  const nodeState = state.activeNodes.get(nodeId);
  if (!nodeState) {
    return;
  }
  state.activeNodes.delete(nodeId);
  if (event.error) {
    safeLog(nodeState.span, { error: toLoggedError(event.error) });
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
    ...(error ? { error: toLoggedError(error) } : {}),
    metrics: buildDurationMetrics(state.startTime),
    ...(output !== undefined ? { output } : {}),
  });
  state.span.end();
  state.attachmentCache.strings.clear();
}

function finalizeMultiAgentStream(
  state: MultiAgentStreamState,
  activeChildParents: ActiveChildParents,
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
    ...(error ? { error: toLoggedError(error) } : {}),
    metrics: buildDurationMetrics(state.startTime),
    ...(output !== undefined ? { output } : {}),
  });
  state.span.end();
}

function extractAgent(agent: unknown, self: unknown): StrandsAgent | undefined {
  const candidate = agent ?? self;
  return isObject(candidate) && typeof candidate.stream === "function"
    ? (candidate as StrandsAgent)
    : undefined;
}

function extractOrchestrator(
  orchestrator: unknown,
  self: unknown,
): StrandsMultiAgent | undefined {
  const candidate = orchestrator ?? self;
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

function extractAgentResultOutput(result: StrandsAgentResult | undefined) {
  if (!result) {
    return undefined;
  }
  if (result.structuredOutput !== undefined) {
    return result.structuredOutput;
  }
  if (result.lastMessage) {
    return result.lastMessage;
  }
  return result;
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
  return result;
}

function extractNodeResultOutput(result: StrandsNodeResultEvent["result"]) {
  if (!result) {
    return undefined;
  }
  if (result.structuredOutput !== undefined) {
    return result.structuredOutput;
  }
  if (Array.isArray(result.content)) {
    return normalizeContentBlocks(result.content);
  }
  return result;
}

const STRANDS_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",
  flv: "video/x-flv",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  wmv: "video/x-ms-wmv",
  "3gp": "video/3gpp",
  pdf: "application/pdf",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
};

function createStrandsAttachmentCache(): StrandsAttachmentCache {
  return {
    objects: new WeakMap(),
    strings: new LRUCache({
      max: MAX_STRANDS_STRING_ATTACHMENT_CACHE_ENTRIES,
    }),
  };
}

function processStrandsInputAttachments(
  input: unknown,
  cache = createStrandsAttachmentCache(),
): unknown {
  try {
    return processStrandsInputNode(input, cache);
  } catch (error) {
    logInstrumentationError("Strands Agent SDK input attachments", error);
    return input;
  }
}

function processStrandsInputNode(
  value: unknown,
  cache: StrandsAttachmentCache,
): unknown {
  if (value instanceof BaseAttachment) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => processStrandsInputNode(child, cache));
  }
  if (!isObject(value)) {
    return value;
  }

  const directMedia = processDirectStrandsMediaBlock(value, cache);
  if (directMedia !== undefined) {
    return directMedia;
  }

  const wrappedMedia = processWrappedStrandsMediaBlock(value, cache);
  if (wrappedMedia !== undefined) {
    return wrappedMedia;
  }

  if (value.type === "message" && Array.isArray(value.content)) {
    return {
      role: value.role,
      content: value.content.map((child) =>
        processStrandsInputNode(child, cache),
      ),
      ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    };
  }

  if (typeof value.toJSON === "function") {
    return processStrandsInputNode(value.toJSON(), cache);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      processStrandsInputNode(child, cache),
    ]),
  );
}

function processDirectStrandsMediaBlock(
  block: Record<string, unknown>,
  cache: StrandsAttachmentCache,
): unknown | undefined {
  if (!isStrandsMediaBlock(block)) {
    return undefined;
  }
  const mediaKey =
    block.type === "imageBlock"
      ? "image"
      : block.type === "videoBlock"
        ? "video"
        : "document";

  return createStrandsMediaAttachment(mediaKey, block, cache);
}

function isStrandsMediaBlock(
  block: Record<string, unknown>,
): block is StrandsMediaBlock {
  return (
    (block.type === "imageBlock" ||
      block.type === "videoBlock" ||
      block.type === "documentBlock") &&
    typeof block.format === "string" &&
    isObject(block.source)
  );
}

function processWrappedStrandsMediaBlock(
  block: Record<string, unknown>,
  cache: StrandsAttachmentCache,
): unknown | undefined {
  for (const mediaKey of ["image", "video", "document"] as const) {
    const media = block[mediaKey];
    if (!Object.hasOwn(block, mediaKey) || !isObject(media)) {
      continue;
    }
    const processed = createStrandsMediaAttachment(mediaKey, media, cache);
    if (processed !== undefined) {
      return processed;
    }
  }
  return undefined;
}

function createStrandsMediaAttachment(
  mediaKey: "image" | "video" | "document",
  media: Record<string, unknown>,
  cache: StrandsAttachmentCache,
): unknown | undefined {
  const format = media.format;
  const source = media.source;
  if (
    typeof format !== "string" ||
    !isObject(source) ||
    !Object.hasOwn(source, "bytes")
  ) {
    return undefined;
  }

  const contentType = STRANDS_MEDIA_TYPES[format.toLowerCase()];
  if (!contentType) {
    return undefined;
  }
  const filename =
    mediaKey === "document" &&
    typeof media.name === "string" &&
    media.name.length > 0
      ? media.name
      : `${mediaKey}.${format.toLowerCase()}`;
  const attachment = getOrCreateStrandsAttachment(
    source.bytes,
    filename,
    contentType,
    cache,
  );
  if (!attachment) {
    return undefined;
  }
  const { type: _type, ...serializedMedia } = media;
  const { type: _sourceType, ...serializedSource } = source;

  return {
    [mediaKey]: {
      ...serializedMedia,
      source: {
        ...serializedSource,
        bytes: attachment,
      },
    },
  };
}

function getOrCreateStrandsAttachment(
  data: unknown,
  filename: string,
  contentType: string,
  cache: StrandsAttachmentCache,
): Attachment | undefined {
  const key = `${contentType}\0${filename}`;
  const attachments =
    typeof data === "string"
      ? cache.strings.get(data)
      : isObject(data)
        ? cache.objects.get(data)
        : undefined;
  const cached = attachments?.get(key);
  if (cached) {
    return cached;
  }

  const blob = convertDataToBlob(data, contentType);
  if (!blob) {
    return undefined;
  }
  const attachment = new Attachment({
    data: blob,
    filename,
    contentType,
  });
  const updatedAttachments = attachments ?? new Map<string, Attachment>();
  updatedAttachments.set(key, attachment);
  if (typeof data === "string") {
    cache.strings.set(data, updatedAttachments);
  } else if (isObject(data)) {
    cache.objects.set(data, updatedAttachments);
  }
  return attachment;
}

function normalizeContentBlocks(blocks: StrandsContentBlock[]): unknown {
  const text = blocks
    .map((block) => (typeof block.text === "string" ? block.text : undefined))
    .filter((part): part is string => Boolean(part))
    .join("");
  return text.length > 0 ? text : blocks;
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
  activeChildParents: ActiveChildParents,
  child: object,
  span: Span,
): void {
  const parents = activeChildParents.get(child) ?? new Set<Span>();
  parents.add(span);
  activeChildParents.set(child, parents);
}

function popChildParent(
  activeChildParents: ActiveChildParents,
  child: object,
  span: Span,
): void {
  const parents = activeChildParents.get(child);
  if (!parents) {
    return;
  }
  parents.delete(span);
  if (parents.size === 0) {
    activeChildParents.delete(child);
  }
}

function getOnlyChildParent(
  activeChildParents: ActiveChildParents,
  child: object,
): Span | undefined {
  const parents = activeChildParents.get(child);
  if (!parents || parents.size !== 1) {
    // Strands does not provide a child stream to node id correlation here.
    // When a reused child has multiple active parents, choosing one would be
    // a guess and can create a false parent/child relationship.
    return undefined;
  }
  return parents.values().next().value;
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
