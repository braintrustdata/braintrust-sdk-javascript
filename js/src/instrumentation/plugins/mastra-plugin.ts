import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import {
  BRAINTRUST_CURRENT_SPAN_STORE,
  _internalGetGlobalState,
  startSpan,
} from "../../logger";
import type { CurrentSpanStore, Span } from "../../logger";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import type {
  AnyAsyncChannel,
  AsyncEndOf,
  ChannelMessage,
  StartOf,
} from "../core/channel-definitions";
import { BasePlugin } from "../core";
import { mastraChannels } from "./mastra-channels";
import type {
  MastraAgentExecuteOptions,
  MastraAgentLike,
  MastraAgentNetworkOptions,
  MastraToolContext,
  MastraToolLike,
  MastraWorkflowRestartArgs,
  MastraWorkflowResumeArgs,
  MastraWorkflowRunLike,
  MastraWorkflowStartArgs,
  MastraWorkflowStepParams,
} from "../../vendor-sdk-types/mastra";

type MastraChannel =
  | typeof mastraChannels.agentExecute
  | typeof mastraChannels.agentNetwork
  | typeof mastraChannels.agentResumeNetwork
  | typeof mastraChannels.agentGenerateLegacy
  | typeof mastraChannels.agentStreamLegacy
  | typeof mastraChannels.toolExecute
  | typeof mastraChannels.workflowRunStart
  | typeof mastraChannels.workflowRunResume
  | typeof mastraChannels.workflowRunRestart
  | typeof mastraChannels.workflowStepExecute;

type SpanState = {
  span: Span;
};

type MastraChannelEvent<TChannel extends AnyAsyncChannel> =
  ChannelMessage<TChannel>;

type MastraSpanConfig<TChannel extends AnyAsyncChannel> = {
  createSpan: (event: StartOf<TChannel>) => {
    input: unknown;
    metadata: Record<string, unknown>;
    name: string;
    type: SpanTypeAttribute;
  };
  extractOutput: (
    result: AsyncEndOf<TChannel>["result"],
    event: AsyncEndOf<TChannel>,
  ) => {
    metadata?: Record<string, unknown>;
    output: unknown;
  };
};

export class MastraPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToMastraChannel(mastraChannels.agentExecute, {
      createSpan: (event) => createAgentExecuteSpan(event),
      extractOutput: (result) => ({ output: extractAgentOutput(result) }),
    });
    this.subscribeToMastraChannel(mastraChannels.agentNetwork, {
      createSpan: (event) => createAgentMethodSpan(event, "network"),
      extractOutput: (result) => ({ output: extractAgentOutput(result) }),
    });
    this.subscribeToMastraChannel(mastraChannels.agentResumeNetwork, {
      createSpan: (event) => createAgentMethodSpan(event, "resumeNetwork"),
      extractOutput: (result) => ({ output: extractAgentOutput(result) }),
    });
    this.subscribeToMastraChannel(mastraChannels.agentGenerateLegacy, {
      createSpan: (event) => createAgentMethodSpan(event, "generateLegacy"),
      extractOutput: (result) => ({ output: extractAgentOutput(result) }),
    });
    this.subscribeToMastraChannel(mastraChannels.agentStreamLegacy, {
      createSpan: (event) => createAgentMethodSpan(event, "streamLegacy"),
      extractOutput: (result) => ({ output: extractAgentOutput(result) }),
    });
    this.subscribeToMastraChannel(mastraChannels.toolExecute, {
      createSpan: (event) => createToolSpan(event),
      extractOutput: (result) => ({ output: result }),
    });
    this.subscribeToMastraChannel(mastraChannels.workflowRunStart, {
      createSpan: (event) => createWorkflowRunSpan(event, "start"),
      extractOutput: (result) => ({
        output: extractWorkflowRunOutput(result),
        metadata: extractWorkflowRunOutputMetadata(result),
      }),
    });
    this.subscribeToMastraChannel(mastraChannels.workflowRunResume, {
      createSpan: (event) => createWorkflowRunSpan(event, "resume"),
      extractOutput: (result) => ({
        output: extractWorkflowRunOutput(result),
        metadata: extractWorkflowRunOutputMetadata(result),
      }),
    });
    this.subscribeToMastraChannel(mastraChannels.workflowRunRestart, {
      createSpan: (event) => createWorkflowRunSpan(event, "restart"),
      extractOutput: (result) => ({
        output: extractWorkflowRunOutput(result),
        metadata: extractWorkflowRunOutputMetadata(result),
      }),
    });
    this.subscribeToMastraChannel(mastraChannels.workflowStepExecute, {
      createSpan: (event) => createWorkflowStepSpan(event),
      extractOutput: (result) => ({
        output: extractWorkflowStepOutput(result),
      }),
    });
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToMastraChannel<TChannel extends MastraChannel>(
    channel: TChannel,
    config: MastraSpanConfig<TChannel>,
  ): void {
    const tracingChannel =
      channel.tracingChannel() as unknown as IsoTracingChannel<
        MastraChannelEvent<TChannel>
      >;
    const states = new WeakMap<object, SpanState>();
    const pendingStates: SpanState[] = [];
    const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
      tracingChannel,
      states,
      config,
    );

    const handlers: IsoChannelHandlers<MastraChannelEvent<TChannel>> = {
      start: (event) => {
        const key = event;
        const existing = states.get(key);
        if (existing) {
          return;
        }
        const created = startSpanForEvent(config, event);
        states.set(key, created);
        pendingStates.push(created);
      },
      asyncEnd: (event) => {
        const state = states.get(event) ?? pendingStates.shift();
        if (!state) {
          return;
        }

        try {
          const { output, metadata = {} } = config.extractOutput(
            event.result as AsyncEndOf<TChannel>["result"],
            event as AsyncEndOf<TChannel>,
          );
          state.span.log({
            output,
            metadata,
            metrics: {},
          });
        } finally {
          state.span.end();
          states.delete(event);
          const pendingIndex = pendingStates.indexOf(state);
          if (pendingIndex >= 0) {
            pendingStates.splice(pendingIndex, 1);
          }
        }
      },
      error: (event) => {
        const state = states.get(event) ?? pendingStates.shift();
        if (!state || !event.error) {
          return;
        }
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
        const pendingIndex = pendingStates.indexOf(state);
        if (pendingIndex >= 0) {
          pendingStates.splice(pendingIndex, 1);
        }
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
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

function startSpanForEvent<TChannel extends AnyAsyncChannel>(
  config: MastraSpanConfig<TChannel>,
  event: StartOf<TChannel>,
): SpanState {
  const { name, type, input, metadata } = config.createSpan(event);
  const span = startSpan({
    name,
    spanAttributes: {
      type,
    },
  });

  span.log({
    input,
    metadata,
  });

  return { span };
}

function bindCurrentSpanStoreToStart<TChannel extends AnyAsyncChannel>(
  tracingChannel: IsoTracingChannel<MastraChannelEvent<TChannel>>,
  states: WeakMap<object, SpanState>,
  config: MastraSpanConfig<TChannel>,
): (() => void) | undefined {
  const state = _internalGetGlobalState();
  const contextManager = state?.contextManager;
  const startChannel = tracingChannel.start as
    | ({
        bindStore?: (
          store: CurrentSpanStore,
          callback: (event: MastraChannelEvent<TChannel>) => unknown,
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
    const span = ensureState(states, event, () =>
      startSpanForEvent(config, event),
    ).span;
    return contextManager.wrapSpanForStore(span);
  });

  return () => {
    startChannel.unbindStore?.(currentSpanStore);
  };
}

function createAgentExecuteSpan(
  event: StartOf<typeof mastraChannels.agentExecute>,
): ReturnType<
  MastraSpanConfig<typeof mastraChannels.agentExecute>["createSpan"]
> {
  const self = event.self as MastraAgentLike | undefined;
  const options = event.arguments[0] ?? {};
  const method = stringValue(options.methodType) ?? "execute";
  const metadata = agentMetadata(self, options, method);

  return {
    name: `Mastra Agent ${agentDisplayName(self)} ${method}`,
    type: SpanTypeAttribute.TASK,
    input: options.messages ?? options.input ?? options,
    metadata,
  };
}

function createAgentMethodSpan(
  event:
    | StartOf<typeof mastraChannels.agentNetwork>
    | StartOf<typeof mastraChannels.agentResumeNetwork>
    | StartOf<typeof mastraChannels.agentGenerateLegacy>
    | StartOf<typeof mastraChannels.agentStreamLegacy>,
  method: string,
): {
  input: unknown;
  metadata: Record<string, unknown>;
  name: string;
  type: SpanTypeAttribute;
} {
  const self = event.self as MastraAgentLike | undefined;
  const options = (event.arguments[1] ?? {}) as MastraAgentNetworkOptions;
  const metadata = agentMetadata(self, options, method);

  return {
    name: `Mastra Agent ${agentDisplayName(self)} ${method}`,
    type: SpanTypeAttribute.TASK,
    input: event.arguments[0],
    metadata,
  };
}

function createToolSpan(
  event: StartOf<typeof mastraChannels.toolExecute>,
): ReturnType<
  MastraSpanConfig<typeof mastraChannels.toolExecute>["createSpan"]
> {
  const self = event.self as MastraToolLike | undefined;
  const context = event.arguments[1] as MastraToolContext | undefined;
  const toolId = toolDisplayName(self);

  return {
    name: `Mastra Tool ${toolId}`,
    type: SpanTypeAttribute.TOOL,
    input: event.arguments[0],
    metadata: cleanMetadata({
      tool_id: toolId,
      agent_id: context?.agent?.agentId,
      tool_call_id: context?.agent?.toolCallId,
      thread_id: context?.agent?.threadId,
      resource_id: context?.agent?.resourceId,
      workflow_id: context?.workflow?.workflowId,
      workflow_run_id: context?.workflow?.runId,
    }),
  };
}

function createWorkflowRunSpan(
  event:
    | StartOf<typeof mastraChannels.workflowRunStart>
    | StartOf<typeof mastraChannels.workflowRunResume>
    | StartOf<typeof mastraChannels.workflowRunRestart>,
  method: "start" | "resume" | "restart",
): {
  input: unknown;
  metadata: Record<string, unknown>;
  name: string;
  type: SpanTypeAttribute;
} {
  const self = event.self as MastraWorkflowRunLike | undefined;
  const args = event.arguments[0];
  const workflowId = stringValue(self?.workflowId) ?? "workflow";

  return {
    name: `Mastra Workflow ${workflowId} ${method}`,
    type: SpanTypeAttribute.TASK,
    input: extractWorkflowRunInput(args, method),
    metadata: cleanMetadata({
      workflow_id: workflowId,
      run_id: self?.runId,
      resource_id: self?.resourceId,
      method,
    }),
  };
}

function createWorkflowStepSpan(
  event: StartOf<typeof mastraChannels.workflowStepExecute>,
): ReturnType<
  MastraSpanConfig<typeof mastraChannels.workflowStepExecute>["createSpan"]
> {
  const stepId = event.arguments[0];
  const params = event.arguments[2] as MastraWorkflowStepParams | undefined;

  return {
    name: `Mastra Workflow Step ${stepId}`,
    type: SpanTypeAttribute.FUNCTION,
    input: undefined,
    metadata: cleanMetadata({
      step_id: stepId,
      workflow_id: params?.workflowId,
      workflow_run_id: params?.runId,
      resource_id: params?.resourceId,
    }),
  };
}

function agentDisplayName(agent: MastraAgentLike | undefined): string {
  return stringValue(agent?.name) ?? stringValue(agent?.id) ?? "Agent";
}

function agentMetadata(
  agent: MastraAgentLike | undefined,
  options: MastraAgentExecuteOptions | MastraAgentNetworkOptions,
  method: string,
): Record<string, unknown> {
  const memory = readAgentMemory(options);

  return cleanMetadata({
    agent_id: agent?.id,
    agent_name: agent?.name,
    method,
    run_id: options.runId,
    resource_id: options.resourceId ?? memory?.resource,
    thread_id: options.threadId ?? extractThreadId(options),
  });
}

function toolDisplayName(tool: MastraToolLike | undefined): string {
  return (
    stringValue(tool?.id) ??
    stringValue(tool?.toolName) ??
    stringValue(tool?.name) ??
    "tool"
  );
}

function extractThreadId(
  options: MastraAgentExecuteOptions | MastraAgentNetworkOptions,
): string | undefined {
  const memoryThread = readAgentMemory(options)?.thread;
  if (typeof memoryThread === "string") {
    return memoryThread;
  }
  return stringValue(memoryThread?.id);
}

function readAgentMemory(
  options: MastraAgentExecuteOptions | MastraAgentNetworkOptions,
): MastraAgentNetworkOptions["memory"] | undefined {
  if (!("memory" in options) || !isObject(options.memory)) {
    return undefined;
  }

  return options.memory;
}

function extractAgentOutput(result: unknown): unknown {
  if (!isObject(result)) {
    return result;
  }

  const output: Record<string, unknown> = {};
  for (const key of ["text", "object", "files", "result", "status"]) {
    if (key in result) {
      output[key] = result[key];
    }
  }

  return Object.keys(output).length > 0 ? output : result;
}

function extractWorkflowRunInput(
  args:
    | MastraWorkflowStartArgs
    | MastraWorkflowResumeArgs
    | MastraWorkflowRestartArgs
    | undefined,
  method: "start" | "resume" | "restart",
): unknown {
  if (!args) {
    return undefined;
  }
  if (method === "resume") {
    return args.resumeData ?? args;
  }
  return args.inputData ?? args;
}

function extractWorkflowRunOutput(result: unknown): unknown {
  if (!isObject(result)) {
    return result;
  }

  if ("status" in result || "result" in result) {
    return cleanMetadata({
      status: result.status,
      result: result.result,
    });
  }

  return result;
}

function extractWorkflowRunOutputMetadata(
  result: unknown,
): Record<string, unknown> {
  if (!isObject(result)) {
    return {};
  }
  return cleanMetadata({
    run_id: result.runId,
    resource_id: result.resourceId,
  });
}

function extractWorkflowStepOutput(result: unknown): unknown {
  if (!isObject(result)) {
    return result;
  }
  if ("status" in result) {
    return cleanMetadata({
      status: result.status,
      output: result.output,
      error: result.error,
    });
  }
  return result;
}

function cleanMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
