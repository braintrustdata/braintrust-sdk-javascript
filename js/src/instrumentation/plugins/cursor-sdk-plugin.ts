import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers } from "../../isomorph";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp } from "../../util";
import { SpanTypeAttribute } from "../../../util/index";
import { cursorSDKChannels } from "./cursor-sdk-channels";
import type {
  CursorSDKAgent,
  CursorSDKAgentOptions,
  CursorSDKConversationStep,
  CursorSDKConversationTurn,
  CursorSDKInteractionUpdate,
  CursorSDKMessage,
  CursorSDKModelSelection,
  CursorSDKRun,
  CursorSDKRunGitInfo,
  CursorSDKRunResult,
  CursorSDKSendOptions,
  CursorSDKToolCall,
  CursorSDKToolUseMessage,
  CursorSDKUsage,
  CursorSDKUserMessage,
} from "../../vendor-sdk-types/cursor-sdk";

const PATCHED_AGENT = Symbol.for("braintrust.cursor-sdk.auto-patched-agent");
const PATCHED_RUN = Symbol.for("braintrust.cursor-sdk.patched-run");
const WRAPPED_AGENT = Symbol.for("braintrust.cursor-sdk.wrapped-agent");

type ToolState = {
  span: Span;
  subAgentSpan?: Span;
};

type CursorRunState = {
  activeToolSpans: Map<string, ToolState>;
  agent?: CursorSDKAgent;
  deltaText: string[];
  streamText: string[];
  stepText: string[];
  conversationOutput?: unknown;
  conversationText: string[];
  finalized: boolean;
  input: string | CursorSDKUserMessage;
  lastResult?: CursorSDKRunResult;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  run?: CursorSDKRun;
  span: Span;
  startTime: number;
  streamMessages: CursorSDKMessage[];
  taskText: string[];
};

type PromptState = {
  metadata: Record<string, unknown>;
  span: Span;
  startTime: number;
};

export class CursorSDKPlugin extends BasePlugin {
  private promptDepth = 0;

  protected onEnable(): void {
    this.subscribeToAgentFactories();
    this.subscribeToPrompt();
    this.subscribeToSend();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.promptDepth = 0;
  }

  private subscribeToAgentFactories(): void {
    this.subscribeToAgentFactory(cursorSDKChannels.create);
    this.subscribeToAgentFactory(cursorSDKChannels.resume);
  }

  private subscribeToAgentFactory(
    channel: typeof cursorSDKChannels.create | typeof cursorSDKChannels.resume,
  ): void {
    const tracingChannel = channel.tracingChannel();
    const handlers: IsoChannelHandlers<ChannelMessage<typeof channel>> = {
      asyncEnd: (event) => {
        patchCursorAgentInPlace(event.result);
      },
      error: () => {},
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToPrompt(): void {
    const channel = cursorSDKChannels.prompt.tracingChannel();
    const states = new WeakMap<object, PromptState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof cursorSDKChannels.prompt>
    > = {
      start: (event) => {
        this.promptDepth += 1;
        const message = event.arguments[0];
        const options = event.arguments[1];
        const metadata = {
          ...extractAgentOptionsMetadata(options),
          "cursor_sdk.operation": "Agent.prompt",
          provider: "cursor",
          ...(event.moduleVersion
            ? { "cursor_sdk.version": event.moduleVersion }
            : {}),
        };
        const span = startSpan({
          name: "Cursor Agent",
          spanAttributes: { type: SpanTypeAttribute.TASK },
        });
        const startTime = getCurrentUnixTimestamp();
        safeLog(span, {
          input: sanitizeUserMessage(message),
          metadata,
        });
        states.set(event, { metadata, span, startTime });
      },
      asyncEnd: (event) => {
        this.promptDepth = Math.max(0, this.promptDepth - 1);
        const state = states.get(event);
        if (!state) {
          return;
        }
        try {
          safeLog(state.span, {
            metadata: {
              ...state.metadata,
              ...extractRunResultMetadata(event.result),
            },
            metrics: buildDurationMetrics(state.startTime),
            output: event.result?.result ?? event.result,
          });
        } finally {
          state.span.end();
          states.delete(event);
        }
      },
      error: (event) => {
        this.promptDepth = Math.max(0, this.promptDepth - 1);
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        safeLog(state.span, { error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }

  private subscribeToSend(): void {
    const channel = cursorSDKChannels.send.tracingChannel();
    const states = new WeakMap<object, CursorRunState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof cursorSDKChannels.send>
    > = {
      start: (event) => {
        if (this.promptDepth > 0) {
          return;
        }

        const message = event.arguments[0];
        const sendOptions = event.arguments[1];
        const agent = event.agent;
        const metadata = {
          ...extractSendMetadata(sendOptions),
          ...(agent ? extractAgentMetadata(agent) : {}),
          "cursor_sdk.operation": "agent.send",
          provider: "cursor",
          ...(event.moduleVersion
            ? { "cursor_sdk.version": event.moduleVersion }
            : {}),
        };
        const span = startSpan({
          name: "Cursor Agent",
          spanAttributes: { type: SpanTypeAttribute.TASK },
        });
        const startTime = getCurrentUnixTimestamp();
        safeLog(span, {
          input: sanitizeUserMessage(message),
          metadata,
        });

        const state: CursorRunState = {
          activeToolSpans: new Map(),
          agent,
          conversationText: [],
          deltaText: [],
          finalized: false,
          input: message,
          metadata,
          metrics: {},
          span,
          startTime,
          streamMessages: [],
          streamText: [],
          stepText: [],
          taskText: [],
        };

        if (hasCursorCallbacks(sendOptions)) {
          event.arguments[1] = wrapSendOptionsCallbacks(sendOptions, state);
        }
        states.set(event, state);
      },
      asyncEnd: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        if (!event.result) {
          return;
        }
        state.run = event.result;
        state.metadata = {
          ...state.metadata,
          ...extractRunMetadata(event.result),
        };
        patchCursorRun(event.result, state);
      },
      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        safeLog(state.span, { error: event.error.message });
        endOpenToolSpans(state, event.error.message);
        state.span.end();
        state.finalized = true;
        states.delete(event);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }
}

function patchCursorAgentInPlace(agent: unknown): void {
  if (!agent || typeof agent !== "object") {
    return;
  }
  const agentRecord = agent as CursorSDKAgent & Record<PropertyKey, unknown>;
  if (
    agentRecord[PATCHED_AGENT] ||
    agentRecord[WRAPPED_AGENT] ||
    typeof agentRecord.send !== "function"
  ) {
    return;
  }

  const originalSend = agentRecord.send.bind(agentRecord);
  try {
    Object.defineProperty(agentRecord, PATCHED_AGENT, {
      configurable: false,
      enumerable: false,
      value: true,
    });
    Object.defineProperty(agentRecord, "send", {
      configurable: true,
      value(
        message: string | CursorSDKUserMessage,
        options?: CursorSDKSendOptions,
      ) {
        const args = [message, options] as [
          string | CursorSDKUserMessage,
          CursorSDKSendOptions | undefined,
        ];
        return cursorSDKChannels.send.tracePromise(
          () => originalSend(...args),
          {
            agent: agentRecord,
            arguments: args,
            operation: "send",
          } as never,
        );
      },
      writable: true,
    });
  } catch {
    // Frozen/sealed agents cannot be patched. Leave user behavior untouched.
  }
}

function wrapSendOptionsCallbacks(
  options: CursorSDKSendOptions,
  state: CursorRunState,
): CursorSDKSendOptions {
  const originalOnDelta = options.onDelta;
  const originalOnStep = options.onStep;

  return {
    ...options,
    async onDelta(args) {
      try {
        await handleInteractionUpdate(state, args.update);
      } catch (error) {
        logInstrumentationError("Cursor SDK onDelta", error);
      }
      if (originalOnDelta) {
        return originalOnDelta(args);
      }
    },
    async onStep(args) {
      try {
        handleStepUpdate(state, args.step);
      } catch (error) {
        logInstrumentationError("Cursor SDK onStep", error);
      }
      if (originalOnStep) {
        return originalOnStep(args);
      }
    },
  };
}

function hasCursorCallbacks(
  options: CursorSDKSendOptions | undefined,
): options is CursorSDKSendOptions {
  return (
    !!options &&
    (typeof options.onDelta === "function" ||
      typeof options.onStep === "function")
  );
}

function patchCursorRun(run: CursorSDKRun, state: CursorRunState): void {
  if (!run || typeof run !== "object") {
    return;
  }
  const runRecord = run as CursorSDKRun & Record<PropertyKey, unknown>;
  if (runRecord[PATCHED_RUN]) {
    return;
  }

  try {
    Object.defineProperty(runRecord, PATCHED_RUN, {
      configurable: false,
      enumerable: false,
      value: true,
    });

    if (typeof runRecord.stream === "function") {
      const originalStream = runRecord.stream.bind(runRecord);
      Object.defineProperty(runRecord, "stream", {
        configurable: true,
        value() {
          const stream = originalStream();
          return patchCursorStream(stream, state);
        },
        writable: true,
      });
    }

    if (typeof runRecord.wait === "function") {
      const originalWait = runRecord.wait.bind(runRecord);
      Object.defineProperty(runRecord, "wait", {
        configurable: true,
        async value() {
          try {
            const result = await originalWait();
            state.lastResult = result;
            await finalizeCursorRun(state, { result });
            return result;
          } catch (error) {
            await finalizeCursorRun(state, { error });
            throw error;
          }
        },
        writable: true,
      });
    }

    if (typeof runRecord.conversation === "function") {
      const originalConversation = runRecord.conversation.bind(runRecord);
      Object.defineProperty(runRecord, "conversation", {
        configurable: true,
        async value() {
          try {
            const conversation = await originalConversation();
            await handleConversation(state, conversation);
            await finalizeCursorRun(state);
            return conversation;
          } catch (error) {
            await finalizeCursorRun(state, { error });
            throw error;
          }
        },
        writable: true,
      });
    }
  } catch {
    // If the Run object is not patchable, finish the span with available data.
    void finalizeCursorRun(state, { output: run });
  }
}

async function* patchCursorStream(
  stream: AsyncGenerator<CursorSDKMessage, void>,
  state: CursorRunState,
): AsyncGenerator<CursorSDKMessage, void> {
  try {
    for await (const message of stream) {
      try {
        await handleStreamMessage(state, message);
      } catch (error) {
        logInstrumentationError("Cursor SDK stream", error);
      }
      yield message;
    }
    await finalizeCursorRun(state);
  } catch (error) {
    await finalizeCursorRun(state, { error });
    throw error;
  }
}

async function handleInteractionUpdate(
  state: CursorRunState,
  update: CursorSDKInteractionUpdate,
): Promise<void> {
  switch (update.type) {
    case "text-delta":
      if (typeof update.text === "string") {
        state.deltaText.push(update.text);
      }
      return;
    case "token-delta":
      if (typeof update.tokens === "number") {
        state.metrics["cursor_sdk.delta_tokens"] =
          (state.metrics["cursor_sdk.delta_tokens"] ?? 0) + update.tokens;
      }
      return;
    case "tool-call-started":
    case "partial-tool-call":
    case "tool-call-completed":
      await handleToolUpdate(
        state,
        update as Extract<
          CursorSDKInteractionUpdate,
          {
            type:
              | "tool-call-started"
              | "partial-tool-call"
              | "tool-call-completed";
          }
        >,
      );
      return;
    case "turn-ended":
      addUsageMetrics(
        state.metrics,
        (update as { usage?: CursorSDKUsage }).usage,
      );
      return;
    case "summary":
      if (typeof update.summary === "string") {
        state.taskText.push(update.summary);
      }
      return;
    case "step-completed":
      if (typeof update.stepDurationMs === "number") {
        state.metrics["cursor_sdk.step_duration_ms"] =
          (state.metrics["cursor_sdk.step_duration_ms"] ?? 0) +
          update.stepDurationMs;
      }
      state.metrics["cursor_sdk.steps"] =
        (state.metrics["cursor_sdk.steps"] ?? 0) + 1;
      return;
    default:
      return;
  }
}

async function handleToolUpdate(
  state: CursorRunState,
  update: Extract<
    CursorSDKInteractionUpdate,
    { type: "tool-call-started" | "partial-tool-call" | "tool-call-completed" }
  >,
): Promise<void> {
  const callId = update.callId;
  if (!callId) {
    return;
  }

  const toolCall = update.toolCall;
  const name = extractToolName(toolCall);
  const args = extractToolArgs(toolCall);
  const result = extractToolResult(toolCall);

  if (
    update.type === "tool-call-started" ||
    update.type === "partial-tool-call"
  ) {
    if (!state.activeToolSpans.has(callId)) {
      state.activeToolSpans.set(
        callId,
        await startToolSpan(state, {
          args,
          callId,
          name,
          status: "running",
          toolCall,
        }),
      );
    }
    return;
  }

  const toolState =
    state.activeToolSpans.get(callId) ??
    (await startToolSpan(state, {
      args,
      callId,
      name,
      status: "completed",
      toolCall,
    }));

  finishToolSpan(toolState, {
    error: toolCall?.status === "error" ? stringifyUnknown(result) : undefined,
    metadata: {
      "cursor_sdk.tool.status": toolCall?.status ?? "completed",
    },
    output: result,
  });
  state.activeToolSpans.delete(callId);
}

async function handleStreamMessage(
  state: CursorRunState,
  message: CursorSDKMessage,
): Promise<void> {
  state.streamMessages.push(message);
  if (message.type === "system") {
    const systemMessage = message as Extract<
      CursorSDKMessage,
      { type: "system" }
    >;
    state.metadata = {
      ...state.metadata,
      ...extractModelMetadata(systemMessage.model),
      ...(systemMessage.agent_id
        ? { "cursor_sdk.agent_id": systemMessage.agent_id }
        : {}),
      ...(systemMessage.run_id
        ? { "cursor_sdk.run_id": systemMessage.run_id }
        : {}),
      ...(systemMessage.tools
        ? { "cursor_sdk.tools": systemMessage.tools }
        : {}),
    };
    return;
  }

  if (message.type === "assistant") {
    const assistantMessage = message as Extract<
      CursorSDKMessage,
      { type: "assistant" }
    >;
    for (const block of assistantMessage.message?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") {
        state.streamText.push(block.text);
      } else if (block?.type === "tool_use" && block.id) {
        state.activeToolSpans.set(
          block.id,
          await startToolSpan(state, {
            args: block.input,
            callId: block.id,
            name: block.name,
            status: "running",
          }),
        );
      }
    }
    return;
  }

  if (message.type === "tool_call") {
    await handleToolMessage(
      state,
      message as Extract<CursorSDKMessage, { type: "tool_call" }>,
    );
    return;
  }

  if (message.type === "task" && typeof message.text === "string") {
    state.taskText.push(message.text);
    return;
  }

  if (message.type === "status" && message.status) {
    state.metadata["cursor_sdk.status"] = message.status;
  }
}

async function handleToolMessage(
  state: CursorRunState,
  message: CursorSDKToolUseMessage,
): Promise<void> {
  const callId = message.call_id;
  if (!callId) {
    return;
  }

  if (message.status === "running") {
    if (!state.activeToolSpans.has(callId)) {
      state.activeToolSpans.set(
        callId,
        await startToolSpan(state, {
          args: message.args,
          callId,
          name: message.name,
          status: message.status,
          truncated: message.truncated,
        }),
      );
    }
    return;
  }

  const toolState =
    state.activeToolSpans.get(callId) ??
    (await startToolSpan(state, {
      args: message.args,
      callId,
      name: message.name,
      status: message.status,
      truncated: message.truncated,
    }));
  finishToolSpan(toolState, {
    error:
      message.status === "error" ? stringifyUnknown(message.result) : undefined,
    metadata: {
      "cursor_sdk.tool.status": message.status,
    },
    output: message.result,
  });
  state.activeToolSpans.delete(callId);
}

async function handleConversation(
  state: CursorRunState,
  turns: CursorSDKConversationTurn[],
): Promise<void> {
  state.conversationOutput = turns;
  for (const turn of turns) {
    if (turn.type === "agentConversationTurn") {
      for (const step of turn.turn?.steps ?? []) {
        await handleConversationStep(state, step);
      }
    } else if (turn.type === "shellConversationTurn") {
      const command = turn.turn?.shellCommand?.command;
      if (command) {
        const callId = `shell:${state.activeToolSpans.size}:${command}`;
        const toolState = await startToolSpan(state, {
          args: turn.turn?.shellCommand,
          callId,
          name: "shell",
          status: "completed",
        });
        finishToolSpan(toolState, {
          metadata: { "cursor_sdk.tool.status": "completed" },
          output: turn.turn?.shellOutput,
        });
      }
    }
  }
}

async function handleConversationStep(
  state: CursorRunState,
  step: CursorSDKConversationStep,
): Promise<void> {
  if (
    step.type === "assistantMessage" &&
    typeof step.message?.text === "string"
  ) {
    state.conversationText.push(step.message.text);
    return;
  }

  if (step.type !== "toolCall") {
    return;
  }

  const toolCall = step.message;
  const callId =
    typeof toolCall?.callId === "string"
      ? toolCall.callId
      : `conversation-tool:${state.activeToolSpans.size}`;
  const toolState = await startToolSpan(state, {
    args: extractToolArgs(toolCall),
    callId,
    name: extractToolName(toolCall),
    status: toolCall?.status,
    toolCall,
  });
  finishToolSpan(toolState, {
    error:
      toolCall?.status === "error"
        ? stringifyUnknown(toolCall.result)
        : undefined,
    metadata: {
      "cursor_sdk.tool.status": toolCall?.status ?? "completed",
    },
    output: extractToolResult(toolCall),
  });
}

function handleStepUpdate(
  state: CursorRunState,
  step: CursorSDKConversationStep,
): void {
  state.metrics["cursor_sdk.steps"] =
    (state.metrics["cursor_sdk.steps"] ?? 0) + 1;
  if (step.type) {
    const stepTypes = state.metadata["cursor_sdk.step_types"];
    if (Array.isArray(stepTypes)) {
      if (!stepTypes.includes(step.type)) {
        stepTypes.push(step.type);
      }
    } else {
      state.metadata["cursor_sdk.step_types"] = [step.type];
    }
  }
  if (
    step.type === "assistantMessage" &&
    typeof step.message?.text === "string"
  ) {
    state.stepText.push(step.message.text);
  }
}

async function startToolSpan(
  state: CursorRunState,
  args: {
    args?: unknown;
    callId: string;
    name?: string;
    status?: string;
    toolCall?: CursorSDKToolCall;
    truncated?: { args?: boolean; result?: boolean };
  },
): Promise<ToolState> {
  const name = args.name || "unknown";
  const metadata: Record<string, unknown> = {
    "cursor_sdk.tool.status": args.status,
    "gen_ai.tool.call.id": args.callId,
    "gen_ai.tool.name": name,
  };
  if (args.truncated?.args !== undefined) {
    metadata["cursor_sdk.tool.args_truncated"] = args.truncated.args;
  }
  if (args.truncated?.result !== undefined) {
    metadata["cursor_sdk.tool.result_truncated"] = args.truncated.result;
  }

  const span = startSpan({
    event: {
      input: args.args,
      metadata,
    },
    name: `tool: ${name}`,
    parent: await state.span.export(),
    spanAttributes: { type: SpanTypeAttribute.TOOL },
  });

  let subAgentSpan: Span | undefined;
  if (isSubAgentToolName(name)) {
    subAgentSpan = startSpan({
      event: {
        input: args.args,
        metadata: {
          "cursor_sdk.subagent.tool_call_id": args.callId,
          "gen_ai.tool.name": name,
        },
      },
      name: formatSubAgentSpanName(args.toolCall, args.args),
      parent: await span.export(),
      spanAttributes: { type: SpanTypeAttribute.TASK },
    });
  }

  return { span, subAgentSpan };
}

function finishToolSpan(
  toolState: ToolState,
  result: {
    error?: string;
    metadata?: Record<string, unknown>;
    output?: unknown;
  },
): void {
  try {
    if (result.error) {
      safeLog(toolState.span, {
        error: result.error,
        metadata: result.metadata,
        output: result.output,
      });
      if (toolState.subAgentSpan) {
        safeLog(toolState.subAgentSpan, {
          error: result.error,
          metadata: result.metadata,
          output: result.output,
        });
      }
    } else {
      safeLog(toolState.span, {
        metadata: result.metadata,
        output: result.output,
      });
      if (toolState.subAgentSpan) {
        safeLog(toolState.subAgentSpan, {
          metadata: result.metadata,
          output: result.output,
        });
      }
    }
  } finally {
    toolState.subAgentSpan?.end();
    toolState.span.end();
  }
}

async function finalizeCursorRun(
  state: CursorRunState,
  params: {
    error?: unknown;
    output?: unknown;
    result?: CursorSDKRunResult;
  } = {},
): Promise<void> {
  if (state.finalized) {
    return;
  }
  state.finalized = true;

  const error = params.error;
  const result = params.result ?? state.lastResult;
  const output =
    params.output ??
    result?.result ??
    state.run?.result ??
    (state.conversationText.length > 0
      ? state.conversationText.join("\n")
      : undefined) ??
    state.conversationOutput ??
    (state.streamText.length > 0 ? state.streamText.join("") : undefined) ??
    (state.deltaText.length > 0 ? state.deltaText.join("") : undefined) ??
    (state.stepText.length > 0 ? state.stepText.join("\n") : undefined) ??
    (state.taskText.length > 0 ? state.taskText.join("\n") : undefined);

  try {
    const metadata = {
      ...state.metadata,
      ...(state.run ? extractRunMetadata(state.run) : {}),
      ...(result ? extractRunResultMetadata(result) : {}),
    };
    if (error) {
      safeLog(state.span, {
        error: error instanceof Error ? error.message : String(error),
        metadata,
        metrics: {
          ...cleanMetrics(state.metrics),
          ...buildDurationMetrics(state.startTime),
        },
        output,
      });
    } else {
      safeLog(state.span, {
        metadata,
        metrics: {
          ...cleanMetrics(state.metrics),
          ...buildDurationMetrics(state.startTime),
        },
        output,
      });
    }
  } finally {
    endOpenToolSpans(state);
    state.span.end();
  }
}

function endOpenToolSpans(state: CursorRunState, error?: string): void {
  for (const [, toolState] of state.activeToolSpans) {
    finishToolSpan(toolState, { error });
  }
  state.activeToolSpans.clear();
}

function sanitizeUserMessage(
  message: string | CursorSDKUserMessage | undefined,
): unknown {
  if (typeof message === "string" || message === undefined) {
    return message;
  }
  return {
    ...message,
    images: message.images?.map((image) => {
      const imageRecord = image as Record<string, unknown>;
      return {
        ...(typeof imageRecord.url === "string"
          ? { url: imageRecord.url }
          : {}),
        ...(typeof imageRecord.mimeType === "string"
          ? { mimeType: imageRecord.mimeType }
          : {}),
        ...(image.dimension ? { dimension: image.dimension } : {}),
        hasData: typeof imageRecord.data === "string",
      };
    }),
  };
}

function extractAgentOptionsMetadata(
  options: CursorSDKAgentOptions | Partial<CursorSDKAgentOptions> | undefined,
): Record<string, unknown> {
  if (!options) {
    return {};
  }

  return {
    ...extractModelMetadata(options.model),
    ...(options.agentId ? { "cursor_sdk.agent_id": options.agentId } : {}),
    ...(options.name ? { "cursor_sdk.agent_name": options.name } : {}),
    ...(options.local
      ? {
          "cursor_sdk.runtime": "local",
          "cursor_sdk.local.cwd": Array.isArray(options.local.cwd)
            ? options.local.cwd.join(",")
            : options.local.cwd,
        }
      : {}),
    ...(options.cloud
      ? {
          "cursor_sdk.runtime": "cloud",
          "cursor_sdk.cloud.auto_create_pr": options.cloud.autoCreatePR,
          "cursor_sdk.cloud.env_type": options.cloud.env?.type,
          "cursor_sdk.cloud.env_name": options.cloud.env?.name,
          "cursor_sdk.cloud.repos": options.cloud.repos
            ?.map((repo) => repo.url)
            .filter((url): url is string => typeof url === "string"),
        }
      : {}),
  };
}

function extractSendMetadata(
  options: CursorSDKSendOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {};
  }
  return {
    ...extractModelMetadata(options.model),
    ...(options.local?.force !== undefined
      ? { "cursor_sdk.local.force": options.local.force }
      : {}),
  };
}

function extractAgentMetadata(agent: CursorSDKAgent): Record<string, unknown> {
  return {
    ...(agent.agentId ? { "cursor_sdk.agent_id": agent.agentId } : {}),
    ...extractModelMetadata(agent.model),
  };
}

function extractRunMetadata(
  run: CursorSDKRun | undefined,
): Record<string, unknown> {
  if (!run) {
    return {};
  }
  return {
    ...(run.id ? { "cursor_sdk.run_id": run.id } : {}),
    ...(run.agentId ? { "cursor_sdk.agent_id": run.agentId } : {}),
    ...(run.status ? { "cursor_sdk.status": run.status } : {}),
    ...(run.durationMs !== undefined
      ? { "cursor_sdk.duration_ms": run.durationMs }
      : {}),
    ...extractModelMetadata(run.model),
    ...extractGitMetadata(run.git),
  };
}

function extractRunResultMetadata(
  result: CursorSDKRunResult | undefined,
): Record<string, unknown> {
  if (!result) {
    return {};
  }
  return {
    ...(result.id ? { "cursor_sdk.run_id": result.id } : {}),
    ...(result.status ? { "cursor_sdk.status": result.status } : {}),
    ...(result.durationMs !== undefined
      ? { "cursor_sdk.duration_ms": result.durationMs }
      : {}),
    ...extractModelMetadata(result.model),
    ...extractGitMetadata(result.git),
  };
}

function extractGitMetadata(
  git: CursorSDKRunGitInfo | undefined,
): Record<string, unknown> {
  const branches = git?.branches;
  if (!branches || branches.length === 0) {
    return {};
  }
  return {
    "cursor_sdk.git.branches": branches.map((branch) => ({
      branch: branch.branch,
      prUrl: branch.prUrl,
      repoUrl: branch.repoUrl,
    })),
  };
}

function extractModelMetadata(
  model: CursorSDKModelSelection | undefined,
): Record<string, unknown> {
  if (!model?.id) {
    return {};
  }
  return {
    model: model.id,
    "cursor_sdk.model": model.id,
    ...(model.params ? { "cursor_sdk.model.params": model.params } : {}),
  };
}

function addUsageMetrics(
  metrics: Record<string, number>,
  usage: CursorSDKUsage | undefined,
): void {
  if (!usage) {
    return;
  }
  if (usage.inputTokens !== undefined) {
    metrics.prompt_tokens = (metrics.prompt_tokens ?? 0) + usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    metrics.completion_tokens =
      (metrics.completion_tokens ?? 0) + usage.outputTokens;
  }
  if (usage.cacheReadTokens !== undefined) {
    metrics.prompt_cached_tokens =
      (metrics.prompt_cached_tokens ?? 0) + usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== undefined) {
    metrics.prompt_cache_creation_tokens =
      (metrics.prompt_cache_creation_tokens ?? 0) + usage.cacheWriteTokens;
  }
  metrics.tokens =
    (metrics.prompt_tokens ?? 0) +
    (metrics.completion_tokens ?? 0) +
    (metrics.prompt_cached_tokens ?? 0) +
    (metrics.prompt_cache_creation_tokens ?? 0);
}

function buildDurationMetrics(startTime: number): Record<string, number> {
  const end = getCurrentUnixTimestamp();
  return {
    duration: end - startTime,
    end,
    start: startTime,
  };
}

function extractToolName(toolCall: CursorSDKToolCall | undefined): string {
  if (!toolCall) {
    return "unknown";
  }
  if (typeof toolCall.name === "string") {
    return toolCall.name;
  }
  if (typeof toolCall.type === "string") {
    return toolCall.type;
  }
  return "unknown";
}

function extractToolArgs(toolCall: CursorSDKToolCall | undefined): unknown {
  return toolCall && "args" in toolCall ? toolCall.args : undefined;
}

function extractToolResult(toolCall: CursorSDKToolCall | undefined): unknown {
  return toolCall && "result" in toolCall ? toolCall.result : undefined;
}

function isSubAgentToolName(name: string): boolean {
  return name === "Agent" || name === "Task" || name === "task";
}

function formatSubAgentSpanName(
  toolCall: CursorSDKToolCall | undefined,
  args: unknown,
): string {
  const details = (toolCall ?? args) as Record<string, unknown> | undefined;
  const description =
    getString(details, "description") ??
    getString(details, "subagent_type") ??
    getString(details, "type") ??
    getString(details, "name");
  return description ? `Agent: ${description}` : "Agent: sub-agent";
}

function getString(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
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
    logInstrumentationError("Cursor SDK span log", error);
  }
}

function logInstrumentationError(context: string, error: unknown): void {
  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.error(`Error processing ${context}:`, error);
}

function cleanMetrics(metrics: Record<string, number>): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== undefined && Number.isFinite(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
