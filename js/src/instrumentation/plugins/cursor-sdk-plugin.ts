import { BasePlugin } from "../core";
import { observeResult, runInstrumentation } from "../core/observe-result";

import { SpanTypeAttribute, isObject } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import type { Span } from "../../logger";
import { startSpan as startBaseSpan, withCurrent } from "../../logger";
import iso from "../../isomorph";
import { patchStreamIfNeeded } from "../core/stream-patcher";
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
import {
  cursorSDKChannels,
  patchCursorAgentInPlace,
} from "./cursor-sdk-interceptors";

const PATCHED_RUN = Symbol.for("braintrust.cursor-sdk.patched-run");

type ToolState = {
  span: Span;
  subAgentSpan?: Span;
  ended?: boolean;
};

type CursorRunState = {
  activeToolSpans: Map<string, ToolState>;
  completedToolSpans: Map<string, ToolState>;
  observation: Promise<void>;
  finalizing?: Promise<void>;
  error?: unknown;
  deltaText: string[];
  streamText: string[];
  stepText: string[];
  conversationText: string[];
  finalized: boolean;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  usageComplete: boolean;
  run?: CursorSDKRun;
  span: Span;
  startTime: number;
  taskText: string[];
};

// Scope prompt/send coordination to this invocation, including across awaits.
let promptStore: ReturnType<typeof iso.newAsyncLocalStorage<CursorRunState>>;
function promptContext() {
  return (promptStore ??= iso.newAsyncLocalStorage<CursorRunState>());
}

export class CursorSDKPlugin extends BasePlugin {
  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  protected onEnable(): void {
    for (const channel of [
      cursorSDKChannels.create,
      cursorSDKChannels.resume,
    ]) {
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
    // Preserve the same Cursor run tracing contract for automatic and manual wrapping.
    this.unsubscribers.push(
      cursorSDKChannels.prompt.intercept((target, receiver, args, additional) =>
        traceCursorPrompt(
          () => Reflect.apply(target, receiver, args),
          args,
          additional.moduleVersion,
        ),
      ),
      cursorSDKChannels.send.intercept((target, receiver, args, additional) =>
        traceCursorSend(
          (options) => Reflect.apply(target, receiver, [args[0], options]),
          args,
          additional.agent,
          additional.moduleVersion,
        ),
      ),
    );
  }
}

function createRunState(
  message: string | CursorSDKUserMessage,
  metadata: Record<string, unknown>,
): CursorRunState {
  const span = startBaseSpan(
    withSpanInstrumentationName(
      {
        name: "Cursor Agent",
        spanAttributes: { type: SpanTypeAttribute.TASK },
        event: { input: sanitizeUserMessage(message), metadata },
      },
      INSTRUMENTATION_NAMES.CURSOR_SDK,
    ),
  );
  return {
    activeToolSpans: new Map(),
    completedToolSpans: new Map(),
    observation: Promise.resolve(),
    conversationText: [],
    deltaText: [],
    finalized: false,
    metadata,
    metrics: {},
    usageComplete: true,
    span,
    startTime: getCurrentUnixTimestamp(),
    streamText: [],
    stepText: [],
    taskText: [],
  };
}

function traceCursorPrompt(
  call: () => PromiseLike<CursorSDKRunResult>,
  args: [string | CursorSDKUserMessage, CursorSDKAgentOptions | undefined],
  moduleVersion?: string,
): PromiseLike<CursorSDKRunResult> {
  if (promptContext().getStore()) return call();
  const state = runInstrumentation(() =>
    createRunState(args[0], {
      ...extractAgentOptionsMetadata(args[1]),
      "cursor_sdk.operation": "Agent.prompt",
      provider: "cursor",
      ...(moduleVersion ? { "cursor_sdk.version": moduleVersion } : {}),
    }),
  );
  if (!state) return call();
  let result;
  try {
    result = promptContext().run(state, () => withCurrent(state.span, call));
  } catch (error) {
    void finalizeCursorRun(state, { error });
    throw error;
  }
  return observeResult(
    result,
    (result) => {
      void finalizeCursorRun(state, { result });
    },
    (error) => {
      void finalizeCursorRun(state, { error });
    },
  );
}

function traceCursorSend(
  call: (
    options: CursorSDKSendOptions | undefined,
  ) => PromiseLike<CursorSDKRun>,
  args: [string | CursorSDKUserMessage, CursorSDKSendOptions | undefined],
  agent?: CursorSDKAgent,
  moduleVersion?: string,
): PromiseLike<CursorSDKRun> {
  const state =
    promptContext().getStore() ??
    runInstrumentation(() =>
      createRunState(args[0], {
        ...extractSendMetadata(args[1]),
        ...(agent ? extractAgentMetadata(agent) : {}),
        "cursor_sdk.operation": "agent.send",
        provider: "cursor",
        ...(moduleVersion ? { "cursor_sdk.version": moduleVersion } : {}),
      }),
    );
  if (!state) return call(args[1]);
  const options =
    runInstrumentation(() => wrapSendOptionsCallbacks(args[1] ?? {}, state)) ??
    args[1];
  let result;
  try {
    result = withCurrent(state.span, () => call(options));
  } catch (error) {
    void finalizeCursorRun(state, { error });
    throw error;
  }
  return observeResult(
    result,
    (run) => {
      state.run = run;
      patchCursorRun(run, state);
    },
    (error) => {
      void finalizeCursorRun(state, { error });
    },
  );
}

function observeUpdate(
  state: CursorRunState,
  observe: () => void | Promise<void>,
): void {
  state.observation = state.observation
    .then(async () => {
      if (!state.finalized) await observe();
    })
    .catch((error) => logInstrumentationError("Cursor SDK update", error));
}

function wrapSendOptionsCallbacks(
  options: CursorSDKSendOptions,
  state: CursorRunState,
): CursorSDKSendOptions {
  const originalOnDelta = options.onDelta;
  const originalOnStep = options.onStep;

  return {
    ...options,
    onDelta: function (args) {
      observeUpdate(state, () => handleInteractionUpdate(state, args.update));
      return (
        originalOnDelta &&
        withCurrent(state.span, () =>
          Reflect.apply(originalOnDelta, this, [args]),
        )
      );
    },
    onStep: function (args) {
      observeUpdate(state, () => handleStepUpdate(state, args.step));
      return (
        originalOnStep &&
        withCurrent(state.span, () =>
          Reflect.apply(originalOnStep, this, [args]),
        )
      );
    },
  };
}

function callCursorRun<T>(state: CursorRunState, call: () => T): T {
  try {
    return withCurrent(state.span, call);
  } catch (error) {
    void finalizeCursorRun(state, { error });
    throw error;
  }
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
      const originalStream = runRecord.stream;
      runRecord.stream = function (...args) {
        const stream = callCursorRun(state, () =>
          Reflect.apply(originalStream, runRecord, args),
        );
        patchStreamIfNeeded<CursorSDKMessage>(stream, {
          aroundNext: (next) => withCurrent(state.span, next),
          shouldCollect: (message) => {
            observeUpdate(state, () => handleStreamMessage(state, message));
            return false;
          },
          onComplete: () => finalizeCursorRun(state),
          onCancel: () => finalizeCursorRun(state, { cancelled: true }),
          onError: (error) => finalizeCursorRun(state, { error }),
        });
        return stream;
      };
    }
    if (typeof runRecord.wait === "function") {
      const originalWait = runRecord.wait;
      runRecord.wait = function (...args) {
        const result = callCursorRun(state, () =>
          Reflect.apply(originalWait, runRecord, args),
        );
        return observeResult(
          result,
          (value) => {
            void finalizeCursorRun(state, { result: value });
          },
          (error) => {
            void finalizeCursorRun(state, { error });
          },
        );
      };
    }
    if (typeof runRecord.conversation === "function") {
      const originalConversation = runRecord.conversation;
      runRecord.conversation = function (...args) {
        return observeResult(
          callCursorRun(state, () =>
            Reflect.apply(originalConversation, runRecord, args),
          ),
          (turns) => {
            observeUpdate(state, () => handleConversation(state, turns));
            if (run.status && run.status !== "running")
              void finalizeCursorRun(state);
          },
          (error) => {
            void finalizeCursorRun(state, { error });
          },
        );
      };
    }
    if (typeof runRecord.cancel === "function") {
      const originalCancel = runRecord.cancel;
      runRecord.cancel = function (...args) {
        return observeResult(
          callCursorRun(state, () =>
            Reflect.apply(originalCancel, runRecord, args),
          ),
          () => {
            void finalizeCursorRun(state, { cancelled: true });
          },
          (error) => {
            void finalizeCursorRun(state, { error });
          },
        );
      };
    }
  } catch (error) {
    logInstrumentationError("Cursor SDK run patch", error);
    void finalizeCursorRun(state);
  }
}

async function handleInteractionUpdate(
  state: CursorRunState,
  update: CursorSDKInteractionUpdate,
): Promise<void> {
  switch (update.type) {
    case "text-delta":
      if (typeof update.text === "string" && update.text.length > 0) {
        recordFirstToken(state);
        state.deltaText.push(update.text);
      }
      return;
    case "token-delta":
      // Token deltas do not distinguish input/output or cache categories.
      // Only turn-ended usage can establish canonical token totals.
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
      addUsageMetrics(state, (update as { usage?: CursorSDKUsage }).usage);
      return;
    case "summary":
      if (typeof update.summary === "string") {
        state.taskText.push(update.summary);
      }
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
  if (!update.callId) return;
  await recordTool(
    state,
    update.callId,
    update.toolCall ?? {},
    update.type === "tool-call-completed",
    update.status,
  );
}

function toolMetadata(
  toolCall: Pick<CursorSDKToolCall, "truncated">,
  status?: string,
): Record<string, unknown> {
  return {
    ...(status ? { "cursor_sdk.tool.status": status } : {}),
    ...(typeof toolCall.truncated?.args === "boolean"
      ? { "cursor_sdk.tool.args_truncated": toolCall.truncated.args }
      : {}),
    ...(typeof toolCall.truncated?.result === "boolean"
      ? { "cursor_sdk.tool.result_truncated": toolCall.truncated.result }
      : {}),
  };
}

async function recordTool(
  state: CursorRunState,
  callId: string,
  toolCall: CursorSDKToolCall,
  completed: boolean,
  reportedStatus?: string,
  parent?: Span,
  scope = "",
  ancestors = new Set<unknown>(),
): Promise<void> {
  const key = `${scope}/${callId}`;
  const finished = state.completedToolSpans.get(key);
  if (ancestors.has(toolCall)) return;
  if (finished && !completed) {
    finished.span.log({
      ...(toolCall.args !== undefined ? { input: toolCall.args } : {}),
      metadata: toolMetadata(toolCall),
    });
    return;
  }
  const result = extractToolResult(toolCall);
  const resultRecord = asRecord(result);
  if (resultRecord && ancestors.has(resultRecord)) return;
  const failed =
    reportedStatus === "error" ||
    toolCall.status === "error" ||
    resultRecord?.status === "error";
  const status = failed
    ? "error"
    : (reportedStatus ??
      toolCall.status ??
      (completed ? "completed" : "running"));
  let toolState = finished ?? state.activeToolSpans.get(key);
  if (!toolState) {
    toolState = await startToolSpan(state, {
      args: toolCall.args,
      callId,
      name: extractToolName(toolCall),
      status,
      parent,
      truncated: toolCall.truncated,
    });
    state.activeToolSpans.set(key, toolState);
  } else {
    toolState.span.log({
      ...(toolCall.args !== undefined ? { input: toolCall.args } : {}),
      metadata: toolMetadata(toolCall, status),
    });
  }
  if (!completed) return;
  // Task results contain normalized SDK steps or protobuf JSON steps.
  const nested = asRecord(resultRecord?.value)?.conversationSteps;
  if (toolState.subAgentSpan && Array.isArray(nested)) {
    const seen = new Set(ancestors).add(toolCall);
    if (resultRecord) seen.add(resultRecord);
    for (const [index, step] of nested.entries()) {
      await handleConversationStep(
        state,
        step,
        toolState.subAgentSpan,
        key,
        index,
        seen,
      );
    }
  }
  const error = failed
    ? (resultRecord?.error ?? result ?? new Error("Cursor tool failed"))
    : undefined;
  finishToolSpan(toolState, {
    error,
    metadata: toolMetadata(toolCall, status),
    output: result,
  });
  state.activeToolSpans.delete(key);
  state.completedToolSpans.set(key, toolState);
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
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        recordFirstToken(state);
        state.streamText.push(block.text);
      } else if (block?.type === "tool_use" && block.id) {
        await recordTool(
          state,
          block.id,
          { name: block.name, args: block.input },
          false,
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

  if (message.type === "request" && typeof message.request_id === "string") {
    state.metadata.request_id = message.request_id;
  }
  if (message.type === "status" && typeof message.status === "string") {
    state.metadata["cursor_sdk.status"] = message.status.toLowerCase();
    if (message.status.toLowerCase() === "error") {
      state.error =
        typeof message.message === "string"
          ? message.message
          : new Error("Cursor run failed");
    }
  }
}

async function handleToolMessage(
  state: CursorRunState,
  message: CursorSDKToolUseMessage,
): Promise<void> {
  if (!message.call_id) return;
  await recordTool(
    state,
    message.call_id,
    {
      name: message.name,
      args: message.args,
      result: message.result,
      status: message.status,
      truncated: message.truncated,
    },
    message.status !== "running",
    message.status,
  );
}

async function handleConversation(
  state: CursorRunState,
  turns: CursorSDKConversationTurn[],
): Promise<void> {
  for (const [turnIndex, turn] of turns.entries()) {
    if (turn.type === "agentConversationTurn") {
      for (const [index, step] of (turn.turn?.steps ?? []).entries()) {
        await handleConversationStep(
          state,
          step,
          undefined,
          `turn:${turnIndex}`,
          index,
        );
      }
    } else if (turn.type === "shellConversationTurn") {
      const command = turn.turn?.shellCommand?.command;
      if (command) {
        const callId = `shell:${turnIndex}`;
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

// Protobuf JSON preserves oneof field names instead of the SDK discriminant.
// Only the known tool variants are accepted; arbitrary properties are never used.
const protoToolNames = {
  shellToolCall: "shell",
  readToolCall: "read",
  writeToolCall: "write",
  editToolCall: "edit",
  deleteToolCall: "delete",
  globToolCall: "glob",
  grepToolCall: "grep",
  lsToolCall: "ls",
  mcpToolCall: "mcp",
  readLintsToolCall: "readLints",
  semSearchToolCall: "semSearch",
  createPlanToolCall: "createPlan",
  updateTodosToolCall: "updateTodos",
  taskToolCall: "task",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function normalizeToolCall(value: unknown): CursorSDKToolCall | undefined {
  const record = asRecord(value);
  if (!record) return;
  if (typeof record.type === "string" || typeof record.name === "string")
    return record as CursorSDKToolCall;
  for (const [field, name] of Object.entries(protoToolNames)) {
    const tool = asRecord(record[field]);
    if (!tool) continue;
    const result = asRecord(tool.result);
    return {
      type: name,
      args: tool.args,
      result:
        result && "success" in result
          ? { status: "success", value: result.success }
          : result && "error" in result
            ? { status: "error", error: result.error }
            : result,
    };
  }
}

async function handleConversationStep(
  state: CursorRunState,
  value: unknown,
  parent?: Span,
  scope = "",
  index = 0,
  ancestors = new Set<unknown>(),
): Promise<void> {
  const step = asRecord(value);
  if (!step) return;
  const assistant = asRecord(
    step.type === "assistantMessage" ? step.message : step.assistantMessage,
  );
  if (typeof assistant?.text === "string") {
    if (parent) parent.log({ output: assistant.text });
    else state.conversationText.push(assistant.text);
    return;
  }
  const toolCall = normalizeToolCall(
    step.type === "toolCall" ? step.message : step.toolCall,
  );
  if (!toolCall) return;
  const callId =
    typeof toolCall.callId === "string"
      ? toolCall.callId
      : `conversation-tool:${index}`;
  await recordTool(
    state,
    callId,
    toolCall,
    true,
    undefined,
    parent,
    !parent && typeof toolCall.callId === "string" ? "" : scope,
    ancestors,
  );
}

function handleStepUpdate(
  state: CursorRunState,
  step: CursorSDKConversationStep,
): void {
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
    truncated?: { args?: boolean; result?: boolean };
    parent?: Span;
  },
): Promise<ToolState> {
  const name = args.name || "unknown";
  const metadata: Record<string, unknown> = {
    ...toolMetadata(args, args.status),
    "gen_ai.tool.call.id": args.callId,
    "gen_ai.tool.name": name,
  };

  const span = startBaseSpan(
    withSpanInstrumentationName(
      {
        event: {
          input: args.args,
          metadata,
        },
        name,
        parent: await (args.parent ?? state.span).export(),
        spanAttributes: { type: SpanTypeAttribute.TOOL },
      },
      INSTRUMENTATION_NAMES.CURSOR_SDK,
    ),
  );

  let subAgentSpan: Span | undefined;
  if (isSubAgentToolName(name)) {
    subAgentSpan = startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: args.args,
            metadata: {
              "cursor_sdk.subagent.tool_call_id": args.callId,
              "gen_ai.tool.name": name,
            },
          },
          name: "Cursor Subagent",
          parent: await span.export(),
          spanAttributes: { type: SpanTypeAttribute.TASK },
        },
        INSTRUMENTATION_NAMES.CURSOR_SDK,
      ),
    );
  }

  return { span, subAgentSpan };
}

function finishToolSpan(
  toolState: ToolState,
  result: {
    error?: unknown;
    metadata?: Record<string, unknown>;
    output?: unknown;
  },
): void {
  toolState.span.log(result);
  toolState.subAgentSpan?.log(result);
  if (!toolState.ended) {
    toolState.ended = true;
    toolState.subAgentSpan?.end();
    toolState.span.end();
  }
}

function finalizeCursorRun(
  state: CursorRunState,
  params: {
    error?: unknown;
    result?: CursorSDKRunResult;
    cancelled?: boolean;
  } = {},
): Promise<void> {
  if (state.finalizing) return state.finalizing;
  // Drain queued observations before ending, including un-awaited SDK callbacks.
  state.finalizing = state.observation.then(() => {
    state.finalized = true;
    const event = runInstrumentation(() => {
      const result = params.result;
      const metadata = {
        ...state.metadata,
        ...extractRunMetadata(state.run),
        ...extractRunResultMetadata(result),
        ...(params.cancelled ? { "cursor_sdk.status": "cancelled" } : {}),
      };
      const error =
        params.error ??
        state.error ??
        (metadata["cursor_sdk.status"] === "error"
          ? new Error("Cursor run failed")
          : undefined);
      const output =
        result?.result ??
        state.run?.result ??
        (state.conversationText.length
          ? state.conversationText.join("\n")
          : undefined) ??
        (state.streamText.length ? state.streamText.join("") : undefined) ??
        (state.deltaText.length ? state.deltaText.join("") : undefined) ??
        (state.stepText.length ? state.stepText.join("\n") : undefined) ??
        (state.taskText.length ? state.taskText.join("\n") : undefined);
      return {
        error,
        metadata,
        output,
        metrics: {
          ...state.metrics,
          start: state.startTime,
          end: getCurrentUnixTimestamp(),
        },
      };
    });
    if (event) state.span.log(event);
    for (const tool of state.activeToolSpans.values()) {
      finishToolSpan(tool, {
        error: event?.error ?? params.error ?? state.error,
        metadata:
          params.cancelled ||
          event?.metadata["cursor_sdk.status"] === "cancelled"
            ? { "cursor_sdk.tool.status": "cancelled" }
            : undefined,
      });
    }
    state.activeToolSpans.clear();
    state.completedToolSpans.clear();
    state.span.end();
  });
  return state.finalizing;
}

function sanitizeUserMessage(
  message: string | CursorSDKUserMessage | undefined,
): unknown {
  if (typeof message === "string" || message === undefined) {
    return message;
  }
  return {
    text: message.text,
    images: message.images?.map((image) => {
      const imageRecord = image as Record<string, unknown>;
      return {
        ...(typeof imageRecord.url === "string"
          ? { url: imageRecord.url }
          : {}),
        ...(typeof imageRecord.mimeType === "string"
          ? { mimeType: imageRecord.mimeType }
          : {}),
        ...(image.dimension
          ? {
              dimension: {
                width: image.dimension.width,
                height: image.dimension.height,
              },
            }
          : {}),
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
    ...(model.params
      ? {
          "cursor_sdk.model.params": model.params.map((param) => ({
            id: param.id,
            value: param.value,
          })),
        }
      : {}),
  };
}

function addUsageMetrics(
  state: CursorRunState,
  usage: CursorSDKUsage | undefined,
): void {
  if (!usage) return;
  const metrics = state.metrics;
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const add = (name: string, value: unknown) => {
    if (count(value)) metrics[name] = (metrics[name] ?? 0) + value;
  };
  // Cursor reports uncached input and cache reads/writes as separate buckets.
  // Cache detail metrics are subsets of the inclusive prompt total.
  if (count(usage.inputTokens)) {
    add(
      "prompt_tokens",
      usage.inputTokens +
        (count(usage.cacheReadTokens) ? usage.cacheReadTokens : 0) +
        (count(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0),
    );
  }
  add("completion_tokens", usage.outputTokens);
  add("prompt_cached_tokens", usage.cacheReadTokens);
  add("prompt_cache_creation_tokens", usage.cacheWriteTokens);
  state.usageComplete &&= count(usage.inputTokens) && count(usage.outputTokens);
  if (state.usageComplete) {
    metrics.tokens =
      (metrics.prompt_tokens ?? 0) + (metrics.completion_tokens ?? 0);
  } else {
    // An incomplete turn makes the run's computed total incomplete too.
    delete metrics.tokens;
  }
}

function recordFirstToken(state: CursorRunState): void {
  state.metrics.time_to_first_token ??=
    getCurrentUnixTimestamp() - state.startTime;
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

function extractToolResult(toolCall: CursorSDKToolCall | undefined): unknown {
  return toolCall && "result" in toolCall ? toolCall.result : undefined;
}

function isSubAgentToolName(name: string): boolean {
  return name === "Agent" || name === "Task" || name === "task";
}

function logInstrumentationError(context: string, error: unknown): void {
  debugLogger.error(`Error processing ${context}:`, error);
}
