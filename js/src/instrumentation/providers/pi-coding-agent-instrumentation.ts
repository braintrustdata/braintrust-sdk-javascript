import { toLoggedError } from "../core";

import { SpanTypeAttribute, isObject } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import iso, { type IsoAsyncLocalStorage } from "#braintrust-platform";
import type { Span } from "../../logger/core";
import {
  _internalStartSpan as startBaseSpan,
  _internalCaptureAttachmentsEnabled,
  withCurrent,
} from "../../logger/core";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  PiAgent,
  PiAgentEvent,
  PiAgentSession,
  PiAssistantMessage,
  PiAssistantMessageEvent,
  PiAssistantMessageEventStream,
  PiContext,
  PiImageContent,
  PiMessage,
  PiModel,
  PiPromptOptions,
  PiSimpleStreamOptions,
  PiStreamFunction,
  PiSystemMessage,
  PiTextContent,
  PiTool,
  PiToolCall,
  PiToolResultMessage,
} from "../../vendor-sdk-types/pi-coding-agent";
import {
  isAutoCaptureAttachmentsEnabled,
  processInputAttachments,
} from "../../wrappers/attachment-utils";
import {
  runWithAutoInstrumentationAllowed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import type { ChannelMessage } from "../core/tracing-types";
import { observeResult, runInstrumentation } from "../core/observe-result";
import { piCodingAgentChannels } from "./pi-coding-agent-interceptors";

type PiPromptState = {
  activeLlmSpans: Set<PiLlmSpanState>;
  activeToolSpans: Map<string, PiToolSpanState>;
  agent: PiAgent;
  finalized: boolean;
  metadata: Record<string, unknown>;
  output?: unknown;
  error?: string;
  span: Span;
  startTime: number;
};

type PiLlmSpanState = {
  finalized: boolean;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  span: Span;
  startTime: number;
};

type PiToolSpanState = {
  span: Span;
  executed: boolean;
};

type PiAgentPatchState = {
  originalStreamFunction: PiStreamFunction;
  property: "streamFn" | "streamFunction";
  wrappedStreamFunction: PiStreamFunction;
};

const piAgentPatchStates = new WeakMap<PiAgent, PiAgentPatchState>();
const piEventSubscriptions = new WeakSet<PiAgentSession>();
const PI_TOOL_EXECUTE_WRAPPED = Symbol.for(
  "braintrust.pi_coding_agent.tool_execute_wrapped",
);
let piPromptContextStore: IsoAsyncLocalStorage<PiPromptState> | undefined;

class PiCodingAgentInstrumentationConsumer {
  public register(): void {
    this.interceptPrompt();
    void piCodingAgentChannels.toolExecute.intercept((target, receiver, args) =>
      tracePiToolExecution(
        () => Reflect.apply(target, receiver, args),
        args[0],
      ),
    );
  }

  private interceptPrompt(): void {
    void piCodingAgentChannels.prompt.intercept(
      (target, thisArg, args, additional) => {
        const invokeTarget = () => Reflect.apply(target, thisArg, args);
        let state: PiPromptState | undefined;
        try {
          state = startPiPromptRun({
            ...additional,
            arguments: args,
            self: thisArg,
          });
        } catch (error) {
          logInstrumentationError("Pi Coding Agent prompt start", error);
        }

        if (!state) {
          return promptContextStore().run(undefined, () =>
            runWithAutoInstrumentationSuppressed(invokeTarget),
          );
        }

        return promptContextStore().run(state, () =>
          runWithAutoInstrumentationSuppressed(() => {
            let result: PromiseLike<void>;
            try {
              result = invokeTarget();
            } catch (error) {
              finishPiPromptRun(state, error);
              throw error;
            }

            return observeResult(
              result,
              () => finishPiPromptRun(state),
              (error) => {
                finishPiPromptRun(state, error);
              },
            );
          }),
        );
      },
    );
  }
}

export function registerPiCodingAgentInstrumentation(): void {
  new PiCodingAgentInstrumentationConsumer().register();
}

function startPiPromptRun(
  event: ChannelMessage<typeof piCodingAgentChannels.prompt>,
): PiPromptState | undefined {
  const session = extractSession(event);
  const agent = session?.agent;
  if (!session || !isPiAgent(agent)) {
    return undefined;
  }
  // A prompt submitted during streaming only enqueues work. Its result arrives
  // through a separate lifecycle, which is excluded from automatic tracing.
  if (event.arguments[1]?.streamingBehavior && session.isStreaming !== false) {
    return undefined;
  }
  installPiAgentInstrumentation(agent, session);
  wrapPiToolExecutors(agent.state?.tools);

  const metadata = {
    ...extractSessionMetadata(session),
    ...extractPromptOptionsMetadata(event.arguments[1]),
    "pi_coding_agent.operation": "AgentSession.prompt",
    ...(session.model?.provider || agent.state?.model?.provider
      ? { provider: session.model?.provider ?? agent.state?.model?.provider }
      : {}),
    ...(session.model?.id || agent.state?.model?.id
      ? { model: session.model?.id ?? agent.state?.model?.id }
      : {}),
    ...(event.moduleVersion
      ? { "pi_coding_agent.version": event.moduleVersion }
      : {}),
  };
  const span = startBaseSpan(
    withSpanInstrumentationName(
      {
        event: {
          input: extractPromptInput(event.arguments[0], event.arguments[1]),
          metadata,
        },
        name: "AgentSession.prompt",
        spanAttributes: { type: SpanTypeAttribute.TASK },
      },
      INSTRUMENTATION_NAMES.PI_CODING_AGENT,
    ),
  );
  const state: PiPromptState = {
    activeLlmSpans: new Set(),
    activeToolSpans: new Map(),
    agent,
    finalized: false,
    metadata,
    span,
    startTime: getCurrentUnixTimestamp(),
  };

  return state;
}

function extractSession(
  event: ChannelMessage<typeof piCodingAgentChannels.prompt>,
): PiAgentSession | undefined {
  const candidate = event.session ?? event.self;
  return isObject(candidate) &&
    typeof candidate.prompt === "function" &&
    typeof candidate.subscribe === "function"
    ? (candidate as PiAgentSession)
    : undefined;
}

function isPiAgent(value: unknown): value is PiAgent {
  return (
    isObject(value) &&
    (typeof value.streamFunction === "function" ||
      typeof value.streamFn === "function")
  );
}

function promptContextStore(): IsoAsyncLocalStorage<PiPromptState> {
  piPromptContextStore ??= iso.newAsyncLocalStorage<PiPromptState>();
  return piPromptContextStore;
}

function currentPiPromptState(): PiPromptState | undefined {
  return promptContextStore().getStore();
}

function installPiAgentInstrumentation(
  agent: PiAgent,
  session: PiAgentSession,
): void {
  // Pi's replaceable provider callback may come from application code outside
  // transformed modules. Patch its live value to cover those custom providers.
  const property =
    typeof agent.streamFunction === "function" ? "streamFunction" : "streamFn";
  const streamFunction = agent[property];
  const existing = piAgentPatchStates.get(agent);
  if (
    streamFunction &&
    (!existing ||
      existing.property !== property ||
      streamFunction !== existing.wrappedStreamFunction)
  ) {
    const patchState = {
      originalStreamFunction: streamFunction,
      property,
      wrappedStreamFunction: streamFunction,
    } satisfies PiAgentPatchState;
    patchState.wrappedStreamFunction = makeInstrumentedStreamFunction(
      agent,
      patchState.originalStreamFunction,
      property,
    );
    agent[property] = patchState.wrappedStreamFunction;
    piAgentPatchStates.set(agent, patchState);
  }

  // Session events include calls made through ctx.executeTool(), which the
  // underlying agent does not emit.
  if (piEventSubscriptions.has(session)) {
    return;
  }
  try {
    session.subscribe((event) => {
      const state = currentPiPromptState();
      if (!state || state.agent !== agent || state.finalized) {
        return;
      }
      try {
        runWithAutoInstrumentationSuppressed(() =>
          handlePiAgentEvent(state, event),
        );
      } catch (error) {
        logInstrumentationError("Pi Coding Agent event", error);
      }
    });
    piEventSubscriptions.add(session);
  } catch (error) {
    logInstrumentationError("Pi Coding Agent event subscription", error);
  }
}

function makeInstrumentedStreamFunction(
  agent: PiAgent,
  originalStreamFunction: PiStreamFunction,
  property: PiAgentPatchState["property"],
): PiStreamFunction {
  return function instrumentedPiStreamFunction(
    this: unknown,
    model: PiModel,
    context: PiContext,
    options?: PiSimpleStreamOptions,
  ) {
    const invokeOriginal = () =>
      Reflect.apply(originalStreamFunction, this, [model, context, options]);
    const state = currentPiPromptState();
    if (!state || state.agent !== agent || state.finalized) {
      return invokeOriginal();
    }

    runInstrumentation(() => {
      wrapPiToolExecutors(agent.state?.tools);
      wrapPiToolExecutors(context.tools);
    });
    const llmState = runInstrumentation(() =>
      startPiLlmSpan(state, model, context, property, options),
    );
    try {
      const result = runWithAutoInstrumentationSuppressed(invokeOriginal);
      if (!llmState) return result;
      return observeResult(
        result,
        (stream) => {
          patchAssistantMessageStream(stream, state, llmState);
        },
        (error) => finishPiLlmSpan(state, llmState, undefined, error),
      );
    } catch (error) {
      if (llmState) finishPiLlmSpan(state, llmState, undefined, error);
      throw error;
    }
  };
}

// Tools are runtime-provided callbacks that the module transformer cannot target.
function wrapPiToolExecutors(tools: PiTool[] | undefined): void {
  if (!tools) {
    return;
  }

  for (const tool of tools) {
    try {
      const execute = tool.execute;
      if (
        typeof execute !== "function" ||
        (execute as typeof execute & { [PI_TOOL_EXECUTE_WRAPPED]?: boolean })[
          PI_TOOL_EXECUTE_WRAPPED
        ]
      ) {
        continue;
      }

      const wrappedExecute = function (this: unknown, ...args: unknown[]) {
        // Prompts may still be running after their plugin is disabled.
        return runWithAutoInstrumentationAllowed(() =>
          piCodingAgentChannels.toolExecute.invoke(execute, this, args, {}),
        );
      };
      Object.defineProperty(wrappedExecute, PI_TOOL_EXECUTE_WRAPPED, {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      });
      tool.execute = wrappedExecute;
    } catch (error) {
      logInstrumentationError("Pi Coding Agent tool wrapping", error);
    }
  }
}

function tracePiToolExecution<T>(call: () => T, toolCallId: unknown): T {
  return runWithAutoInstrumentationAllowed(() => {
    const state = currentPiPromptState();
    const toolState =
      !state?.finalized && typeof toolCallId === "string"
        ? state?.activeToolSpans.get(toolCallId)
        : undefined;
    if (!toolState) return call();
    toolState.executed = true;
    return withCurrent(toolState.span, call);
  });
}

function startPiLlmSpan(
  state: PiPromptState,
  model: PiModel,
  context: PiContext,
  property: PiAgentPatchState["property"],
  options?: PiSimpleStreamOptions,
): PiLlmSpanState {
  const metadata = {
    ...extractModelMetadata(model),
    ...extractStreamOptionsMetadata(options),
    ...extractSamplingMetadata(model, options),
    ...extractToolMetadata(resolvePiContextTools(context)),
    "pi_coding_agent.operation": `agent.${property}`,
  };
  const span = withCurrent(state.span, () =>
    startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: processInputAttachments(
              normalizePiContextInput(context),
              isAutoCaptureAttachmentsEnabled(),
            ),
            metadata,
          },
          name: getLlmSpanName(model),
          spanAttributes: { type: SpanTypeAttribute.LLM },
        },
        INSTRUMENTATION_NAMES.PI_CODING_AGENT,
      ),
    ),
  );
  const llmState = {
    finalized: false,
    metadata,
    metrics: {},
    span,
    startTime: getCurrentUnixTimestamp(),
  };
  state.activeLlmSpans.add(llmState);
  return llmState;
}

function patchAssistantMessageStream(
  stream: PiAssistantMessageEventStream,
  promptState: PiPromptState,
  llmState: PiLlmSpanState,
): PiAssistantMessageEventStream {
  if (!isObject(stream)) {
    return stream;
  }

  const streamRecord = stream as PiAssistantMessageEventStream &
    Record<PropertyKey, unknown>;
  const originalResult = stream.result;
  if (typeof originalResult === "function") {
    streamRecord.result = function patchedPiResult(
      this: PiAssistantMessageEventStream,
    ) {
      return observeResult(
        Reflect.apply(originalResult, this, []),
        (message) => {
          finishPiLlmSpan(promptState, llmState, message);
        },
        (error) => {
          finishPiLlmSpan(promptState, llmState, undefined, error);
        },
      );
    };
  }

  const originalIterator = stream[Symbol.asyncIterator];
  if (typeof originalIterator === "function") {
    streamRecord[Symbol.asyncIterator] = function patchedPiIterator(
      this: PiAssistantMessageEventStream,
    ): AsyncIterator<PiAssistantMessageEvent> &
      AsyncIterable<PiAssistantMessageEvent> {
      const iterator = Reflect.apply(
        originalIterator,
        this,
        [],
      ) as AsyncIterator<PiAssistantMessageEvent>;

      return {
        async next() {
          try {
            const result = await iterator.next();
            if (result.done) {
              finishPiLlmSpan(promptState, llmState);
              return result;
            }

            runInstrumentation(() =>
              recordPiAssistantMessageEvent(
                promptState,
                llmState,
                result.value,
              ),
            );
            return result;
          } catch (error) {
            finishPiLlmSpan(promptState, llmState, undefined, error);
            if (typeof iterator.return === "function") {
              try {
                await iterator.return();
              } catch (cleanupError) {
                logInstrumentationError(
                  "Pi Coding Agent stream cleanup",
                  cleanupError,
                );
              }
            }
            throw error;
          }
        },
        async return(value?: unknown) {
          try {
            if (typeof iterator.return === "function") {
              return await iterator.return(value);
            }
            return {
              done: true,
              value,
            } as IteratorResult<PiAssistantMessageEvent>;
          } catch (error) {
            finishPiLlmSpan(promptState, llmState, undefined, error);
            throw error;
          } finally {
            finishPiLlmSpan(promptState, llmState);
          }
        },
        async throw(error?: unknown) {
          try {
            if (typeof iterator.throw === "function") {
              return await iterator.throw(error);
            }
            throw error;
          } catch (thrownError) {
            finishPiLlmSpan(promptState, llmState, undefined, thrownError);
            throw thrownError;
          }
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  }

  return stream;
}

function recordPiAssistantMessageEvent(
  promptState: PiPromptState,
  llmState: PiLlmSpanState,
  event: PiAssistantMessageEvent,
): void {
  recordFirstTokenMetric(llmState, event);

  const message = "message" in event ? event.message : undefined;
  const errorMessage = "error" in event ? event.error : undefined;

  if (event.type === "done" && isPiAssistantMessage(message)) {
    finishPiLlmSpan(promptState, llmState, message);
  } else if (event.type === "error" && isPiAssistantMessage(errorMessage)) {
    finishPiLlmSpan(promptState, llmState, errorMessage);
  }
}

function recordFirstTokenMetric(
  state: PiLlmSpanState,
  event: PiAssistantMessageEvent,
): void {
  if (
    state.metrics.time_to_first_token !== undefined ||
    !["text_delta", "thinking_delta", "toolcall_delta"].includes(
      event.type ?? "",
    ) ||
    !("delta" in event) ||
    typeof event.delta !== "string" ||
    event.delta.length === 0
  ) {
    return;
  }

  state.metrics.time_to_first_token =
    getCurrentUnixTimestamp() - state.startTime;
}

function handlePiAgentEvent(state: PiPromptState, event: PiAgentEvent): void {
  if (state.finalized) {
    return;
  }

  switch (event.type) {
    case "message_end":
      if (isPiAssistantMessage(event.message)) {
        recordPiPromptOutput(state, event.message);
      }
      return;
    case "turn_end":
      if (isPiAssistantMessage(event.message)) {
        recordPiPromptOutput(state, event.message);
      }
      return;
    case "tool_execution_start":
      startPiToolSpan(state, event);
      return;
    case "tool_execution_end":
      finishPiToolSpan(state, event);
      return;
    default:
      return;
  }
}

function piMessageError(message: PiAssistantMessage): string | undefined {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return message.errorMessage || `Pi response ${message.stopReason}`;
  }
  return undefined;
}

function recordPiPromptOutput(
  state: PiPromptState,
  message: PiAssistantMessage,
): void {
  state.error = piMessageError(message);
  state.output = state.error
    ? undefined
    : extractAssistantOutput(
        message,
        _internalCaptureAttachmentsEnabled(state.span),
      );
}

function startPiToolSpan(
  state: PiPromptState,
  event: Extract<PiAgentEvent, { type: "tool_execution_start" }>,
): void {
  if (!event.toolCallId || state.activeToolSpans.has(event.toolCallId)) {
    return;
  }

  const metadata = {
    "gen_ai.tool.call.id": event.toolCallId,
    "gen_ai.tool.name": event.toolName,
    "pi_coding_agent.tool.name": event.toolName,
  };
  const parent =
    (event.parentToolCallId &&
      state.activeToolSpans.get(event.parentToolCallId)?.span) ||
    state.span;
  // Session subscribers run synchronously; install the span before Pi invokes
  // the executor rather than yielding while exporting its parent context.
  const span = withCurrent(parent, () =>
    startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: event.args,
            metadata,
          },
          name: event.toolName || "tool",
          spanAttributes: { type: SpanTypeAttribute.TOOL },
        },
        INSTRUMENTATION_NAMES.PI_CODING_AGENT,
      ),
    ),
  );
  state.activeToolSpans.set(event.toolCallId, { span, executed: false });
}

function finishPiToolSpan(
  state: PiPromptState,
  event: Extract<PiAgentEvent, { type: "tool_execution_end" }>,
): void {
  const toolState = state.activeToolSpans.get(event.toolCallId);
  if (!toolState) {
    return;
  }

  state.activeToolSpans.delete(event.toolCallId);
  const metadata = {
    "gen_ai.tool.call.id": event.toolCallId,
    "gen_ai.tool.name": event.toolName,
    "pi_coding_agent.tool.name": event.toolName,
    "pi_coding_agent.tool.is_error": event.isError,
    ...(toolState.executed ? { tool_approval: "approved" } : {}),
  };
  try {
    const output = runInstrumentation(() =>
      withCurrent(toolState.span, () => normalizePiToolOutput(event.result)),
    );
    toolState.span.log({
      ...(event.isError
        ? {
            error:
              event.result instanceof Error
                ? event.result
                : toLoggedError(output),
          }
        : {}),
      metadata,
      output,
    });
  } finally {
    toolState.span.end();
  }
}

function finishPiPromptRun(state: PiPromptState, error?: unknown): void {
  if (state.finalized) {
    return;
  }
  state.finalized = true;
  finishOpenLlmSpans(state, error);
  finishOpenToolSpans(state, error);

  const metadata = {
    ...state.metadata,
    ...runInstrumentation(() => extractModelMetadata(state.agent.state?.model)),
  };
  try {
    state.span.log({
      ...(error !== undefined || state.error
        ? { error: error ?? state.error }
        : {}),
      metadata,
      // Usage belongs to LLM spans; repeating it here doubles trace rollups and cost.
      metrics: buildTimingMetrics(state.startTime),
      output: state.output,
    });
  } finally {
    state.span.end();
  }
}

function finishOpenLlmSpans(state: PiPromptState, error?: unknown): void {
  for (const llmState of [...state.activeLlmSpans]) {
    finishPiLlmSpan(state, llmState, undefined, error);
  }
}

function finishPiLlmSpan(
  promptState: PiPromptState,
  llmState: PiLlmSpanState,
  message?: PiAssistantMessage,
  error?: unknown,
): void {
  if (llmState.finalized) {
    return;
  }
  llmState.finalized = true;
  promptState.activeLlmSpans.delete(llmState);

  const data = runInstrumentation(() => {
    const messageError = message && piMessageError(message);
    return {
      ...(error || messageError ? { error: error ?? messageError } : {}),
      metadata: {
        ...llmState.metadata,
        ...(message
          ? extractAssistantMetadata(message, llmState.metadata)
          : {}),
      },
      metrics: {
        ...extractUsageMetrics(message?.usage),
        ...cleanMetrics(llmState.metrics),
        ...buildTimingMetrics(llmState.startTime),
      },
      ...(message
        ? {
            output: extractAssistantOutput(
              message,
              _internalCaptureAttachmentsEnabled(llmState.span),
            ),
          }
        : {}),
    };
  });
  if (data) llmState.span.log(data);
  llmState.span.end();
}

function finishOpenToolSpans(state: PiPromptState, error?: unknown): void {
  for (const [, toolState] of state.activeToolSpans) {
    toolState.span.log({
      error: error ?? "Pi tool did not complete",
    });
    toolState.span.end();
  }
  state.activeToolSpans.clear();
}

function normalizePiContextInput(context: PiContext): unknown[] {
  const messages: unknown[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (!isPiSystemMessage(message)) {
      messages.push(...normalizePiMessage(message));
      continue;
    }

    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const initial = messages.length === 0;
    const content = [text];
    // Later system messages are deltas. Name section patches explicitly so
    // replacements and removals retain their meaning without repeating history.
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null && !initial) {
        content.push(`Removed system prompt section ${JSON.stringify(name)}.`);
      } else if (typeof value === "string") {
        content.push(
          initial
            ? value
            : `Updated system prompt section ${JSON.stringify(name)}:\n\n${value}`,
        );
      }
    }
    messages.push({
      role: "system",
      content: content.filter((part) => part.length > 0).join("\n\n"),
    });
  }
  return messages;
}

function resolvePiContextTools(context: PiContext): PiTool[] | undefined {
  const tools = new Map<string, PiTool>();
  let hasDeclarations = false;
  for (const message of context.messages) {
    if (!isPiSystemMessage(message)) {
      continue;
    }
    if (
      message.toolsAdded !== undefined ||
      message.toolsRemoved !== undefined
    ) {
      hasDeclarations = true;
    }
    for (const tool of message.toolsRemoved ?? []) {
      tools.delete(tool.name);
    }
    for (const tool of message.toolsAdded ?? []) {
      tools.set(tool.name, tool);
    }
  }
  return hasDeclarations ? [...tools.values()] : context.tools;
}

function normalizePiMessage(message: PiMessage): unknown[] {
  if (isPiUserMessage(message)) {
    return [
      {
        role: "user",
        content: normalizeUserContent(message.content),
      },
    ];
  }
  if (isPiAssistantMessage(message)) {
    return [normalizeAssistantMessage(message)];
  }
  if (isPiToolResultMessage(message)) {
    return [normalizeToolResultMessage(message)];
  }
  return [];
}

function normalizeAssistantMessage(message: PiAssistantMessage): unknown {
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  const thinking = message.content
    .flatMap((part) =>
      part.type === "thinking" && !part.redacted ? [part.thinking] : [],
    )
    .join("");
  const toolCalls = message.content.flatMap((part) =>
    part.type === "toolCall" ? [normalizeToolCall(part)] : [],
  );

  return {
    role: "assistant",
    content: text || (toolCalls.length > 0 ? null : ""),
    ...(thinking ? { reasoning_content: thinking } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function normalizeToolResultMessage(message: PiToolResultMessage): unknown {
  return {
    role: "tool",
    tool_call_id: message.toolCallId,
    content: normalizeUserContent(message.content),
  };
}

function normalizeUserContent(
  content: string | Array<PiTextContent | PiImageContent>,
): unknown {
  if (typeof content === "string") {
    return content;
  }

  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: {
          url: isAutoCaptureAttachmentsEnabled()
            ? `data:${part.mimeType};base64,${part.data}`
            : "<omitted>",
        },
      };
    }
    return part;
  });
}

function normalizePiToolOutput(result: unknown): unknown {
  const output =
    isObject(result) && Array.isArray(result.content)
      ? {
          ...result,
          content: normalizeUserContent(
            result.content as Array<PiTextContent | PiImageContent>,
          ),
        }
      : result;
  return processInputAttachments(output, isAutoCaptureAttachmentsEnabled());
}

function normalizeToolCall(toolCall: PiToolCall): unknown {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: stringifyArguments(toolCall.arguments),
    },
  };
}

function extractAssistantOutput(
  message: PiAssistantMessage,
  captureAttachments: boolean,
): unknown {
  return processInputAttachments(
    [
      {
        finish_reason: normalizeStopReason(message.stopReason),
        index: 0,
        message: normalizeAssistantMessage(message),
      },
    ],
    captureAttachments,
  );
}

function isPiSystemMessage(message: PiMessage): message is PiSystemMessage {
  return (
    message.role === "system" &&
    (typeof message.content === "string" || Array.isArray(message.content))
  );
}

function isPiUserMessage(
  message: PiMessage,
): message is Extract<PiMessage, { role: "user" }> {
  return message.role === "user" && "content" in message;
}

function isPiAssistantMessage(message: unknown): message is PiAssistantMessage {
  return (
    isObject(message) &&
    message.role === "assistant" &&
    Array.isArray((message as Partial<PiAssistantMessage>).content)
  );
}

function isPiToolResultMessage(
  message: PiMessage,
): message is PiToolResultMessage {
  return (
    message.role === "toolResult" &&
    Array.isArray((message as Partial<PiToolResultMessage>).content)
  );
}

function normalizeStopReason(reason: string | undefined): string {
  switch (reason) {
    case "toolUse":
      return "tool_calls";
    case "length":
    case "stop":
      return reason;
    default:
      return reason ?? "stop";
  }
}

function extractPromptInput(
  text: string | undefined,
  options: PiPromptOptions | undefined,
): unknown {
  const images = options?.images;
  if (!images || images.length === 0) {
    return text;
  }
  return processInputAttachments(
    [
      {
        role: "user",
        content: normalizeUserContent([
          { type: "text", text: text ?? "" },
          ...images,
        ]),
      },
    ],
    isAutoCaptureAttachmentsEnabled(),
  );
}

function extractToolMetadata(
  tools: PiTool[] | undefined,
): Record<string, unknown> {
  if (!tools || tools.length === 0) {
    return {};
  }

  return {
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
      },
    })),
  };
}

function extractModelMetadata(
  model: PiModel | undefined,
): Record<string, unknown> {
  if (!model) {
    return {};
  }

  return {
    ...(model.provider ? { provider: model.provider } : {}),
    ...(model.id ? { model: model.id, "pi_coding_agent.model": model.id } : {}),
    ...(model.api ? { "pi_coding_agent.api": model.api } : {}),
    ...(model.name ? { "pi_coding_agent.model_name": model.name } : {}),
  };
}

function extractAssistantMetadata(
  message: PiAssistantMessage,
  requestMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const model = message.responseModel ?? message.model;
  const provider = message.provider ?? requestMetadata.provider;
  const selectionChanged =
    model &&
    requestMetadata.model &&
    requestMetadata.provider &&
    (model !== requestMetadata.model || provider !== requestMetadata.provider);
  return {
    ...(message.provider ? { provider: message.provider } : {}),
    ...(message.responseModel || message.model
      ? { model: message.responseModel ?? message.model }
      : {}),
    ...(message.api ? { "pi_coding_agent.api": message.api } : {}),
    ...(message.model ? { "pi_coding_agent.model": message.model } : {}),
    ...(message.responseModel
      ? { "pi_coding_agent.response_model": message.responseModel }
      : {}),
    ...(message.responseId
      ? { "pi_coding_agent.response_id": message.responseId }
      : {}),
    ...(selectionChanged
      ? {
          selected_model: `${requestMetadata.provider}/${requestMetadata.model}`,
        }
      : {}),
    ...(message.thinkingLevel
      ? { "pi_coding_agent.thinking_level": message.thinkingLevel }
      : {}),
    ...(message.providerThinkingLevel
      ? {
          "pi_coding_agent.provider_thinking_level":
            message.providerThinkingLevel,
        }
      : {}),
    ...(message.stopReason
      ? { "pi_coding_agent.stop_reason": message.stopReason }
      : {}),
  };
}

function extractSessionMetadata(
  session: PiAgentSession,
): Record<string, unknown> {
  return {
    ...extractModelMetadata(session.model),
    ...(session.sessionId
      ? { "pi_coding_agent.session_id": session.sessionId }
      : {}),
    ...(session.sessionName
      ? { "pi_coding_agent.session_name": session.sessionName }
      : {}),
    ...(session.thinkingLevel
      ? { "pi_coding_agent.thinking_level": session.thinkingLevel }
      : {}),
    ...(typeof session.getActiveToolNames === "function"
      ? { "pi_coding_agent.active_tools": session.getActiveToolNames() }
      : {}),
  };
}

function extractPromptOptionsMetadata(
  options: PiPromptOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {};
  }

  return {
    ...(options.source ? { "pi_coding_agent.source": options.source } : {}),
    ...(options.streamingBehavior
      ? { "pi_coding_agent.streaming_behavior": options.streamingBehavior }
      : {}),
    ...(options.expandPromptTemplates !== undefined
      ? {
          "pi_coding_agent.expand_prompt_templates":
            options.expandPromptTemplates,
        }
      : {}),
  };
}

function extractStreamOptionsMetadata(
  options: PiSimpleStreamOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {};
  }

  return {
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens !== undefined
      ? { max_tokens: options.maxTokens }
      : {}),
    ...(options.toolChoice === "auto" || options.toolChoice === "none"
      ? { tool_choice: options.toolChoice }
      : {}),
    ...(options.reasoning
      ? { "pi_coding_agent.reasoning": options.reasoning }
      : {}),
    ...(options.transport
      ? { "pi_coding_agent.transport": options.transport }
      : {}),
    ...(options.cacheRetention
      ? { "pi_coding_agent.cache_retention": options.cacheRetention }
      : {}),
    ...(options.sessionId
      ? { "pi_coding_agent.session_id": options.sessionId }
      : {}),
    ...(options.timeoutMs !== undefined
      ? { "pi_coding_agent.timeout_ms": options.timeoutMs }
      : {}),
    ...(options.maxRetries !== undefined
      ? { "pi_coding_agent.max_retries": options.maxRetries }
      : {}),
    ...(options.maxRetryDelayMs !== undefined
      ? { "pi_coding_agent.max_retry_delay_ms": options.maxRetryDelayMs }
      : {}),
  };
}

function extractSamplingMetadata(
  model: PiModel,
  options?: PiSimpleStreamOptions,
): Record<string, unknown> {
  // Pi merges samplingParams over named fields only for OpenAI-compatible APIs.
  if (
    ![
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
    ].includes(model.api ?? "")
  ) {
    return {};
  }
  const metadata: Record<string, unknown> = {};
  for (const field of [
    "temperature",
    "top_p",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "stop",
    "response_format",
    "tool_choice",
    "parallel_tool_calls",
    "max_tool_calls",
  ] as const) {
    const request = options?.samplingParams;
    const value =
      request && Object.prototype.hasOwnProperty.call(request, field)
        ? request[field]
        : model.samplingParams?.[field];
    // Request metadata must be JSON data, never executable or cyclic values.
    // Snapshot it independently so one invalid field does not lose the call.
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    const serialized = runInstrumentation(() => JSON.stringify(value));
    if (serialized !== undefined) metadata[field] = JSON.parse(serialized);
  }
  return metadata;
}

function getLlmSpanName(model: PiModel): string {
  switch (model.api) {
    case "anthropic-messages":
      return "anthropic.messages.create";
    case "openai-completions":
      return "Chat Completion";
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return "openai.responses.create";
    case "google-generative-ai":
    case "google-vertex":
      return "generate_content";
    case "mistral-conversations":
      return "mistral.chat.stream";
    case "bedrock-converse-stream":
      return "bedrock.converse_stream";
    default:
      return "pi_ai.streamSimple";
  }
}

function extractUsageMetrics(
  usage: PiAssistantMessage["usage"] | undefined,
): Record<string, number> {
  if (!usage) {
    return {};
  }

  const metrics = cleanMetrics(
    {
      completion_tokens: usage.output,
      completion_reasoning_tokens: usage.reasoning,
      prompt_cache_creation_tokens: usage.cacheWrite,
      prompt_cache_creation_1h_tokens: usage.cacheWrite1h,
      prompt_cached_tokens: usage.cacheRead,
      prompt_tokens: usage.input,
      tokens: usage.totalTokens ?? usage.tokens,
    },
    Number.isSafeInteger,
  );
  // Pi reports cache reads and writes outside `input`. Detail fields remain
  // subsets of these inclusive totals and must not be added a second time.
  if (metrics.prompt_tokens !== undefined) {
    if (
      (usage.cacheRead !== undefined &&
        metrics.prompt_cached_tokens === undefined) ||
      (usage.cacheWrite !== undefined &&
        metrics.prompt_cache_creation_tokens === undefined)
    ) {
      delete metrics.prompt_tokens;
    } else {
      metrics.prompt_tokens +=
        (metrics.prompt_cached_tokens ?? 0) +
        (metrics.prompt_cache_creation_tokens ?? 0);
    }
  }
  if (
    metrics.tokens === undefined &&
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  ) {
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  }
  if (
    metrics.prompt_cache_creation_tokens !== undefined &&
    metrics.prompt_cache_creation_1h_tokens !== undefined &&
    metrics.prompt_cache_creation_tokens >=
      metrics.prompt_cache_creation_1h_tokens
  ) {
    metrics.prompt_cache_creation_5m_tokens =
      metrics.prompt_cache_creation_tokens -
      metrics.prompt_cache_creation_1h_tokens;
  }
  // Pi uses zero for unpriced models. Leave those to backend registry pricing.
  const cost = usage.cost?.total;
  return {
    ...cleanMetrics(metrics, Number.isSafeInteger),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost > 0
      ? { estimated_cost: cost }
      : {}),
  };
}

function buildTimingMetrics(startTime: number): Record<string, number> {
  const end = getCurrentUnixTimestamp();
  return {
    end,
    start: startTime,
  };
}

function cleanMetrics(
  metrics: Record<string, unknown>,
  isValidNumber: (value: number) => boolean = Number.isFinite,
): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && value >= 0 && isValidNumber(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return stringifyUnknown(value);
  }
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

function logInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`${context}:`, error);
}
