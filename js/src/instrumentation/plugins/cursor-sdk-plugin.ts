import { BasePlugin, toLoggedError } from "../core";
import { observeResult, runInstrumentation } from "../core/observe-result";

import { SpanTypeAttribute } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import type { Span } from "../../logger";
import { startSpan as startBaseSpan } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
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
import type { ChannelMessage } from "../core/tracing-types";
import {
  addCursorUsage,
  bindCursorAgentSDKRun,
  metricsFromCursorUsage,
  releaseCursorAgentSDKRun,
  type CursorAgentSDKRunBinding,
} from "./cursor-agent-sdk-context";
import { cursorSDKChannels } from "./cursor-sdk-interceptors";

const PATCHED_AGENT = Symbol.for("braintrust.cursor-sdk.auto-patched-agent");
const PATCHED_RUN = Symbol.for("braintrust.cursor-sdk.patched-run");
const WRAPPED_AGENT = Symbol.for("braintrust.cursor-sdk.wrapped-agent");

type ToolState = {
  nestedTools: Map<string, ToolState>;
  span: Span;
  subAgentMetrics?: Record<string, number>;
  subAgentSpan?: Span;
  subAgentStartTime?: number;
};

type CursorRunState = {
  activeToolSpans: Map<string, ToolState>;
  agent?: CursorSDKAgent;
  counts: Record<string, number>;
  deltaText: string[];
  streamText: string[];
  stepText: string[];
  conversationOutput?: unknown;
  conversationText: string[];
  deltaUsage?: CursorSDKUsage;
  finalized: boolean;
  input: string | CursorSDKUserMessage;
  lastResult?: CursorSDKRunResult;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  streamUsage?: CursorSDKUsage;
  usageLogged?: boolean;
  run?: CursorSDKRun;
  sdkBinding?: CursorAgentSDKRunBinding;
  span: Span;
  startTime: number;
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
    this.unsubscribers.push(
      channel.intercept((target, receiver, args) =>
        observeResult(
          Reflect.apply(target, receiver, args),
          patchCursorAgentInPlace,
          () => {},
        ),
      ),
    );
  }

  private subscribeToPrompt(): void {
    const channel = cursorSDKChannels.prompt;
    const states = new WeakMap<object, PromptState>();

    const removeHandlers = channel.intercept(
      (target, receiver, args, additional) => {
        const event = {
          ...additional,
          arguments: args,
          self: receiver,
        } as ChannelMessage<typeof cursorSDKChannels.prompt>;
        const prepare = (
          event: ChannelMessage<typeof cursorSDKChannels.prompt>,
        ) => {
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
          const span = startBaseSpan(
            withSpanInstrumentationName(
              {
                name: "Cursor Agent",
                spanAttributes: { type: SpanTypeAttribute.TASK },
              },
              INSTRUMENTATION_NAMES.CURSOR_SDK,
            ),
          );
          const startTime = getCurrentUnixTimestamp();
          safeLog(span, {
            input: sanitizeUserMessage(message),
            metadata,
          });
          states.set(event, { metadata, span, startTime });
        };
        const resolved = (
          event: ChannelMessage<typeof cursorSDKChannels.prompt>,
        ) => {
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
        };
        const failed = (
          event: ChannelMessage<typeof cursorSDKChannels.prompt>,
        ) => {
          this.promptDepth = Math.max(0, this.promptDepth - 1);
          const state = states.get(event);
          if (!state || !event.error) {
            return;
          }
          const failure = asLoggedError(event.error);
          if (failure) {
            safeLog(state.span, { error: failure });
          }
          state.span.end();
          states.delete(event);
        };
        runInstrumentation(() => prepare(event));
        let result;
        try {
          result = Reflect.apply(target, receiver, args);
        } catch (error) {
          Object.assign(event, { error });
          runInstrumentation(() => failed(event));
          throw error;
        }
        return observeResult(
          result,
          (value) => {
            Object.assign(event, { result: value });
            resolved(event);
          },
          (error) => {
            Object.assign(event, { error });
            failed(event);
          },
        );
      },
    );
    this.unsubscribers.push(removeHandlers);
  }

  private subscribeToSend(): void {
    const channel = cursorSDKChannels.send;
    const states = new WeakMap<object, CursorRunState>();

    const removeHandlers = channel.intercept(
      (target, receiver, args, additional) => {
        const event = {
          ...additional,
          arguments: args,
          self: receiver,
        } as ChannelMessage<typeof cursorSDKChannels.send>;
        const prepare = (
          event: ChannelMessage<typeof cursorSDKChannels.send>,
        ) => {
          if (this.promptDepth > 0) {
            return;
          }

          const message = event.arguments[0];
          const sendOptions = event.arguments[1];
          const agent = event.agent;
          const metadata: Record<string, unknown> = {
            ...extractSendMetadata(sendOptions),
            ...(agent ? extractAgentMetadata(agent) : {}),
            "cursor_sdk.operation": "agent.send",
            provider: "cursor",
            ...(event.moduleVersion
              ? { "cursor_sdk.version": event.moduleVersion }
              : {}),
          };
          const span = startBaseSpan(
            withSpanInstrumentationName(
              {
                name: "Cursor Agent",
                spanAttributes: { type: SpanTypeAttribute.TASK },
              },
              INSTRUMENTATION_NAMES.CURSOR_SDK,
            ),
          );
          const startTime = getCurrentUnixTimestamp();
          safeLog(span, {
            input: sanitizeUserMessage(message),
            metadata,
          });

          const state: CursorRunState = {
            activeToolSpans: new Map(),
            agent,
            conversationText: [],
            counts: {},
            deltaText: [],
            finalized: false,
            input: message,
            metadata,
            metrics: {},
            span,
            startTime,
            streamText: [],
            stepText: [],
            taskText: [],
          };
          if (agent?.agentId) {
            const sdkBinding: CursorAgentSDKRunBinding = {
              agentId: agent.agentId,
              get finalized() {
                return state.finalized;
              },
              metadata,
              span,
              get usageLogged() {
                return state.usageLogged;
              },
              set usageLogged(value: boolean | undefined) {
                state.usageLogged = value;
              },
            };
            state.sdkBinding = sdkBinding;
            bindCursorAgentSDKRun(sdkBinding);
          }

          if (hasCursorCallbacks(sendOptions)) {
            event.arguments[1] = wrapSendOptionsCallbacks(sendOptions, state);
          }
          states.set(event, state);
        };
        const resolved = (
          event: ChannelMessage<typeof cursorSDKChannels.send>,
        ) => {
          const state = states.get(event);
          if (!state) {
            return;
          }

          if (!event.result) {
            return;
          }
          state.run = event.result;
          Object.assign(state.metadata, extractRunMetadata(event.result));
          patchCursorRun(event.result, state);
        };
        const failed = (
          event: ChannelMessage<typeof cursorSDKChannels.send>,
        ) => {
          const state = states.get(event);
          if (!state || !event.error) {
            return;
          }
          const failure = asLoggedError(event.error);
          if (failure) {
            safeLog(state.span, { error: failure });
          }
          endOpenToolSpans(state, failure);
          state.span.end();
          state.finalized = true;
          releaseCursorAgentSDKRun(state.sdkBinding);
          state.sdkBinding = undefined;
          states.delete(event);
        };
        runInstrumentation(() => prepare(event));
        let result;
        try {
          result = Reflect.apply(target, receiver, args);
        } catch (error) {
          Object.assign(event, { error });
          runInstrumentation(() => failed(event));
          throw error;
        }
        return observeResult(
          result,
          (value) => {
            Object.assign(event, { result: value });
            resolved(event);
          },
          (error) => {
            Object.assign(event, { error });
            failed(event);
          },
        );
      },
    );
    this.unsubscribers.push(removeHandlers);
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
        return cursorSDKChannels.send.invoke(
          originalSend,
          undefined,
          [...args],
          { agent: agentRecord, operation: "send" },
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
      if (typeof update.text === "string" && update.text.length > 0) {
        state.deltaText.push(update.text);
        recordFirstToken(state);
      }
      return;
    case "token-delta":
      if (isFiniteCount(update.tokens)) {
        addCount(state.counts, "cursor_sdk.delta_tokens", update.tokens);
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
      rememberTurnUsage(state, (update as { usage?: CursorSDKUsage }).usage);
      return;
    case "tool-call-delta":
      await handleNestedToolDelta(
        state,
        update as {
          callId?: string;
          taskUpdate?: CursorSDKInteractionUpdate;
        },
      );
      return;
    case "summary":
      if (typeof update.summary === "string") {
        state.taskText.push(update.summary);
      }
      return;
    case "step-completed":
      if (isFiniteCount(update.stepDurationMs)) {
        addCount(
          state.counts,
          "cursor_sdk.step_duration_ms",
          update.stepDurationMs,
        );
      }
      addCount(state.counts, "cursor_sdk.steps", 1);
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
  const truncated = toolCall?.truncated;

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
          truncated,
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
      status:
        typeof toolCall?.status === "string" && toolCall.status
          ? toolCall.status
          : undefined,
      toolCall,
      truncated,
    }));

  const failed = toolCallFailed(toolCall);
  finishToolSpan(toolState, {
    error: failed ? toolError(result) : undefined,
    metadata: {
      ...finalToolStatus(toolCall?.status, failed),
      ...truncationMetadata(truncated),
    },
    output: result,
  });
  state.activeToolSpans.delete(callId);
}

async function handleStreamMessage(
  state: CursorRunState,
  message: CursorSDKMessage,
): Promise<void> {
  if (message.type === "system") {
    const systemMessage = message as Extract<
      CursorSDKMessage,
      { type: "system" }
    >;
    Object.assign(
      state.metadata,
      extractModelMetadata(systemMessage.model),
      systemMessage.agent_id
        ? { "cursor_sdk.agent_id": systemMessage.agent_id }
        : undefined,
      systemMessage.run_id
        ? { "cursor_sdk.run_id": systemMessage.run_id }
        : undefined,
      systemMessage.tools
        ? { "cursor_sdk.tools": systemMessage.tools }
        : undefined,
    );
    return;
  }

  if (message.type === "assistant") {
    const assistantMessage = message as Extract<
      CursorSDKMessage,
      { type: "assistant" }
    >;
    for (const block of assistantMessage.message?.content ?? []) {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        state.streamText.push(block.text);
        recordFirstToken(state);
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

  if (message.type === "usage" && "usage" in message) {
    rememberStreamUsage(state, message.usage as CursorSDKUsage | undefined);
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
    error: message.status === "error" ? toolError(message.result) : undefined,
    metadata: {
      ...finalToolStatus(message.status, message.status === "error"),
      ...truncationMetadata(message.truncated),
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
  const failed = toolCallFailed(toolCall);
  finishToolSpan(toolState, {
    error: failed ? toolError(toolCall?.result) : undefined,
    metadata: finalToolStatus(toolCall?.status, failed),
    output: extractToolResult(toolCall),
  });
}

function handleStepUpdate(
  state: CursorRunState,
  step: CursorSDKConversationStep,
): void {
  addCount(state.counts, "cursor_sdk.steps", 1);
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
    ...reportedToolStatus(args.status),
    "gen_ai.tool.call.id": args.callId,
    "gen_ai.tool.name": name,
  };
  const sessionId = state.metadata["agent_sdk.session_id"];
  const turnId = state.metadata["agent_sdk.turn_id"];
  if (typeof sessionId === "string") {
    metadata["agent_sdk.session_id"] = sessionId;
  }
  if (typeof turnId === "string") {
    metadata["agent_sdk.turn_id"] = turnId;
  }
  Object.assign(metadata, truncationMetadata(args.truncated));

  const span = startBaseSpan(
    withSpanInstrumentationName(
      {
        event: {
          input: args.args,
          metadata,
        },
        name: `tool: ${name}`,
        parent: await state.span.export(),
        spanAttributes: { type: SpanTypeAttribute.TOOL },
      },
      INSTRUMENTATION_NAMES.CURSOR_SDK,
    ),
  );

  let subAgentSpan: Span | undefined;
  let subAgentMetrics: Record<string, number> | undefined;
  let subAgentStartTime: number | undefined;
  if (isSubAgentToolName(name)) {
    subAgentMetrics = {};
    subAgentStartTime = getCurrentUnixTimestamp();
    subAgentSpan = startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: args.args,
            metadata: {
              ...(typeof metadata["agent_sdk.session_id"] === "string"
                ? { "agent_sdk.session_id": metadata["agent_sdk.session_id"] }
                : {}),
              ...(typeof metadata["agent_sdk.turn_id"] === "string"
                ? { "agent_sdk.turn_id": metadata["agent_sdk.turn_id"] }
                : {}),
              "cursor_sdk.subagent.tool_call_id": args.callId,
              "gen_ai.tool.name": name,
            },
          },
          name: formatSubAgentSpanName(args.toolCall, args.args),
          parent: await span.export(),
          spanAttributes: { type: SpanTypeAttribute.TASK },
        },
        INSTRUMENTATION_NAMES.CURSOR_SDK,
      ),
    );
  }

  return {
    nestedTools: new Map(),
    span,
    subAgentMetrics,
    subAgentSpan,
    subAgentStartTime,
  };
}

function finishToolSpan(
  toolState: ToolState,
  result: {
    error?: Error;
    metadata?: Record<string, unknown>;
    output?: unknown;
  },
): void {
  for (const nested of toolState.nestedTools.values()) {
    finishToolSpan(nested, {
      metadata: { "cursor_sdk.tool.status": "incomplete" },
    });
  }
  toolState.nestedTools.clear();
  try {
    const subAgentMetrics = cleanMetrics(toolState.subAgentMetrics ?? {});
    safeLog(toolState.span, {
      ...(result.error ? { error: result.error } : {}),
      metadata: result.metadata,
      output: result.output,
    });
    if (toolState.subAgentSpan) {
      safeLog(toolState.subAgentSpan, {
        ...(result.error ? { error: result.error } : {}),
        metadata: result.metadata,
        ...(Object.keys(subAgentMetrics).length > 0
          ? { metrics: subAgentMetrics }
          : {}),
        output: result.output,
      });
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
      ...state.counts,
      ...(state.run ? extractRunMetadata(state.run) : {}),
      ...(result ? extractRunResultMetadata(result) : {}),
    };
    const reportedError =
      asLoggedError(error) ??
      (result?.error?.message ? new Error(result.error.message) : undefined);
    const usage =
      result?.usage ??
      state.run?.usage ??
      state.deltaUsage ??
      state.streamUsage;
    const usageMetrics = metricsFromCursorUsage(usage);
    if (usageMetrics) {
      state.usageLogged = true;
      metadata["cursor_sdk.usage_scope"] =
        result?.usage || state.run?.usage ? "run" : "turn-ended";
    }
    safeLog(state.span, {
      ...(reportedError ? { error: reportedError } : {}),
      metadata,
      metrics: {
        ...cleanMetrics(state.metrics),
        ...usageMetrics,
        ...buildDurationMetrics(state.startTime),
      },
      output,
    });
  } finally {
    endOpenToolSpans(
      state,
      undefined,
      result?.status === "cancelled" ? "cancelled" : undefined,
    );
    state.span.end();
    releaseCursorAgentSDKRun(state.sdkBinding);
    state.sdkBinding = undefined;
  }
}

function endOpenToolSpans(
  state: CursorRunState,
  error?: Error,
  status?: string,
): void {
  // The run ended while these tools were still running. Record how they
  // ended instead of leaving the start event's "running" status in place.
  const finalStatus = status ?? (error ? "error" : "incomplete");
  for (const [, toolState] of state.activeToolSpans) {
    finishToolSpan(toolState, {
      error,
      metadata: { "cursor_sdk.tool.status": finalStatus },
    });
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
    ...(run.requestId ? { "cursor_sdk.request_id": run.requestId } : {}),
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
    ...(result.requestId ? { "cursor_sdk.request_id": result.requestId } : {}),
    ...(result.id ? { "cursor_sdk.run_id": result.id } : {}),
    ...(result.error?.code
      ? { "cursor_sdk.error_code": result.error.code }
      : {}),
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

function rememberTurnUsage(
  state: CursorRunState,
  usage: CursorSDKUsage | undefined,
): void {
  if (!usage) {
    return;
  }
  state.deltaUsage = state.deltaUsage
    ? addCursorUsage(state.deltaUsage, usage)
    : { ...usage };
}

function rememberStreamUsage(
  state: CursorRunState,
  usage: CursorSDKUsage | undefined,
): void {
  if (!usage) {
    return;
  }
  state.streamUsage = { ...usage };
}

async function handleNestedToolDelta(
  state: CursorRunState,
  update: {
    callId?: string;
    taskUpdate?: CursorSDKInteractionUpdate;
  },
): Promise<void> {
  const parentId = update.callId;
  const taskUpdate = update.taskUpdate;
  if (!parentId || !taskUpdate || typeof taskUpdate !== "object") {
    return;
  }
  if (taskUpdate.type === "turn-ended") {
    return;
  }
  const parent = state.activeToolSpans.get(parentId);
  const parentSpan = parent?.subAgentSpan ?? parent?.span;
  if (!parent || !parentSpan) {
    return;
  }
  const nested: CursorRunState = {
    ...state,
    activeToolSpans: parent.nestedTools,
    conversationOutput: undefined,
    conversationText: [],
    counts: {},
    deltaText: [],
    deltaUsage: undefined,
    finalized: false,
    metrics: parent.subAgentMetrics ?? {},
    sdkBinding: undefined,
    span: parentSpan,
    startTime: parent.subAgentStartTime ?? state.startTime,
    stepText: [],
    streamText: [],
    streamUsage: undefined,
    taskText: [],
  };
  await handleInteractionUpdate(nested, taskUpdate);
}

/**
 * Status for a finished tool span. The start event reports "running", so a
 * completion without an explicit status must still overwrite it.
 */
function finalToolStatus(
  status: unknown,
  failed: boolean,
): Record<string, unknown> {
  const reported =
    typeof status === "string" && status && status !== "running"
      ? status
      : undefined;
  return {
    "cursor_sdk.tool.status": reported ?? (failed ? "error" : "completed"),
  };
}

function reportedToolStatus(status: unknown): Record<string, unknown> {
  return typeof status === "string" && status.length > 0
    ? { "cursor_sdk.tool.status": status }
    : {};
}

function addCount(
  counts: Record<string, number>,
  key: string,
  amount: number,
): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function recordFirstToken(state: CursorRunState): void {
  if (state.metrics.time_to_first_token !== undefined) {
    return;
  }
  state.metrics.time_to_first_token =
    getCurrentUnixTimestamp() - state.startTime;
}

function isFiniteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  if (toolCall.type === "mcp" && isRecord(toolCall.args)) {
    const provider = getString(toolCall.args, "providerIdentifier");
    const toolName = getString(toolCall.args, "toolName");
    if (toolName && isAgentSdkToolProvider(provider)) {
      return toolName;
    }
    if (toolName) {
      return provider ? `${provider}:${toolName}` : toolName;
    }
  }
  if (toolCall.type === "task") {
    return "task";
  }
  if (typeof toolCall.name === "string" && toolCall.name) {
    return toolCall.name;
  }
  if (typeof toolCall.type === "string" && toolCall.type) {
    return toolCall.type;
  }
  return "unknown";
}

function extractToolArgs(toolCall: CursorSDKToolCall | undefined): unknown {
  if (!toolCall || !isRecord(toolCall)) {
    return undefined;
  }
  if (toolCall.type === "mcp" && isRecord(toolCall.args)) {
    const provider = getString(toolCall.args, "providerIdentifier");
    if (isAgentSdkToolProvider(provider)) {
      return toolCall.args.args;
    }
    return toolCall.args.args ?? toolCall.args;
  }
  if (toolCall.type === "task" && isRecord(toolCall.args)) {
    const subagentType = isRecord(toolCall.args.subagentType)
      ? toolCall.args.subagentType
      : undefined;
    return {
      ...(getString(toolCall.args, "description")
        ? { description: toolCall.args.description }
        : {}),
      ...(getString(subagentType, "name")
        ? { subagentType: subagentType?.name }
        : getString(subagentType, "kind")
          ? { subagentType: subagentType?.kind }
          : {}),
    };
  }
  return "args" in toolCall ? toolCall.args : undefined;
}

function extractToolResult(toolCall: CursorSDKToolCall | undefined): unknown {
  if (!toolCall || !("result" in toolCall)) {
    return undefined;
  }
  const result = toolCall.result;
  if (!isRecord(result)) {
    return result;
  }
  if (result.status === "error") {
    return result.error ?? result;
  }
  if (result.status === "success") {
    if (toolCall.type === "mcp") {
      return unwrapMcpToolOutput(result.value);
    }
    return result.value;
  }
  return result;
}

function unwrapMcpToolOutput(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return value;
  }
  const text = value.content
    .map((item) => {
      if (!isRecord(item) || !isRecord(item.text)) {
        return "";
      }
      return typeof item.text.text === "string" ? item.text.text : "";
    })
    .filter((part) => part !== "")
    .join("\n");
  return text !== "" ? text : value;
}

function toolCallFailed(toolCall: CursorSDKToolCall | undefined): boolean {
  if (!toolCall) {
    return false;
  }
  if (toolCall.status === "error") {
    return true;
  }
  const result = toolCall.result;
  if (!isRecord(result)) {
    return false;
  }
  if (result.status === "error") {
    return true;
  }
  return isRecord(result.value) && result.value.isError === true;
}

function isAgentSdkToolProvider(provider: string | undefined): boolean {
  return provider === "custom-user-tools" || provider === "agentsdk-tools";
}

function truncationMetadata(
  truncated: { args?: boolean; result?: boolean } | undefined,
): Record<string, boolean> {
  const metadata: Record<string, boolean> = {};
  if (truncated?.args !== undefined) {
    metadata["cursor_sdk.tool.args_truncated"] = truncated.args;
  }
  if (truncated?.result !== undefined) {
    metadata["cursor_sdk.tool.result_truncated"] = truncated.result;
  }
  return metadata;
}

function isSubAgentToolName(name: string): boolean {
  return name === "Agent" || name === "Task" || name === "task";
}

function formatSubAgentSpanName(
  toolCall: CursorSDKToolCall | undefined,
  args: unknown,
): string {
  const extracted = isRecord(args) ? args : undefined;
  const details = isRecord(toolCall) ? toolCall : undefined;
  // Prefer the configured subagent name. The task description is written by
  // the model, so it changes between runs.
  const description =
    getString(extracted, "subagentType") ??
    getString(extracted, "description") ??
    getString(details, "description") ??
    getString(details, "subagent_type") ??
    getString(details, "type") ??
    getString(details, "name");
  return description ? `Agent: ${description}` : "Agent: sub-agent";
}

function asLoggedError(error: unknown): Error | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    return error;
  }
  const message = toLoggedError(error);
  return message ? new Error(message) : undefined;
}

function toolError(value: unknown): Error | undefined {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string" && value) {
    return new Error(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.message === "string" && value.message) {
    return new Error(value.message);
  }
  if (typeof value.error === "string" && value.error) {
    return new Error(value.error);
  }
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return new Error(value.error.message);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}

function safeLog(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    logInstrumentationError("Cursor SDK span log", error);
  }
}

function logInstrumentationError(context: string, error: unknown): void {
  debugLogger.error(`Error processing ${context}:`, error);
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
