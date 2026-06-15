import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers } from "../../isomorph";
import { debugLogger } from "../../debug-logger";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp } from "../../util";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { piCodingAgentChannels } from "./pi-coding-agent-channels";
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
  PiStreamFn,
  PiTextContent,
  PiTool,
  PiToolCall,
  PiToolResultMessage,
} from "../../vendor-sdk-types/pi-coding-agent";

type PiPromptState = {
  activeLlmSpans: Set<PiLlmSpanState>;
  activeToolSpans: Map<string, Span>;
  agent: PiAgent;
  finalized: boolean;
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
  originalStreamFn: PiStreamFn;
  output?: unknown;
  span: Span;
  startTime: number;
  unsubscribeAgent?: () => void;
  wrappedStreamFn: PiStreamFn;
};

type PiLlmSpanState = {
  finalized: boolean;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  span: Span;
  startTime: number;
};

export class PiCodingAgentPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToPrompt();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToPrompt(): void {
    const channel = piCodingAgentChannels.prompt.tracingChannel();
    const states = new WeakMap<object, PiPromptState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof piCodingAgentChannels.prompt>
    > = {
      start: (event) => {
        const state = startPiPromptRun(event);
        if (state) {
          states.set(event, state);
        }
      },
      asyncEnd: async (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        await finalizePiPromptRun(state);
      },
      error: async (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        await finalizePiPromptRun(state, event.error);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }
}

function startPiPromptRun(
  event: ChannelMessage<typeof piCodingAgentChannels.prompt>,
): PiPromptState | undefined {
  const session = extractSession(event);
  const agent = session?.agent;
  if (!session || !isPiAgent(agent)) {
    return undefined;
  }

  const metadata = {
    ...extractSessionMetadata(session),
    ...extractPromptOptionsMetadata(event.arguments[1]),
    "pi_coding_agent.operation": "AgentSession.prompt",
    provider: session.model?.provider ?? agent.state?.model?.provider ?? "pi",
    ...(session.model?.id || agent.state?.model?.id
      ? { model: session.model?.id ?? agent.state?.model?.id }
      : {}),
    ...(event.moduleVersion
      ? { "pi_coding_agent.version": event.moduleVersion }
      : {}),
  };
  const span = startSpan({
    event: {
      input: extractPromptInput(event.arguments[0], event.arguments[1]),
      metadata,
    },
    name: "AgentSession.prompt",
    spanAttributes: { type: SpanTypeAttribute.TASK },
  });

  const state: PiPromptState = {
    activeLlmSpans: new Set(),
    activeToolSpans: new Map(),
    agent,
    finalized: false,
    metadata,
    metrics: {},
    originalStreamFn: agent.streamFn,
    span,
    startTime: getCurrentUnixTimestamp(),
    wrappedStreamFn: agent.streamFn,
  };
  state.wrappedStreamFn = makeInstrumentedStreamFn(state, agent.streamFn);
  agent.streamFn = state.wrappedStreamFn;

  try {
    state.unsubscribeAgent = agent.subscribe(async (agentEvent) => {
      try {
        await handlePiAgentEvent(state, agentEvent);
      } catch (error) {
        logInstrumentationError("Pi Coding Agent event", error);
      }
    });
  } catch (error) {
    logInstrumentationError("Pi Coding Agent event subscription", error);
  }

  return state;
}

function extractSession(
  event: ChannelMessage<typeof piCodingAgentChannels.prompt>,
): PiAgentSession | undefined {
  const candidate = event.session ?? event.self;
  return isObject(candidate) && typeof candidate.prompt === "function"
    ? (candidate as PiAgentSession)
    : undefined;
}

function isPiAgent(value: unknown): value is PiAgent {
  return (
    isObject(value) &&
    typeof value.streamFn === "function" &&
    typeof value.subscribe === "function"
  );
}

function makeInstrumentedStreamFn(
  state: PiPromptState,
  originalStreamFn: PiStreamFn,
): PiStreamFn {
  return async function instrumentedPiStreamFn(
    this: unknown,
    model: PiModel,
    context: PiContext,
    options?: PiSimpleStreamOptions,
  ) {
    const llmState = await startPiLlmSpan(state, model, context, options);
    try {
      const stream = await Reflect.apply(originalStreamFn, this, [
        model,
        context,
        options,
      ]);
      return patchAssistantMessageStream(stream, state, llmState);
    } catch (error) {
      finishPiLlmSpan(state, llmState, undefined, error);
      throw error;
    }
  };
}

async function startPiLlmSpan(
  state: PiPromptState,
  model: PiModel,
  context: PiContext,
  options?: PiSimpleStreamOptions,
): Promise<PiLlmSpanState> {
  const metadata = {
    ...extractModelMetadata(model),
    ...extractStreamOptionsMetadata(options),
    ...extractToolMetadata(context.tools),
    "pi_coding_agent.operation": "agent.streamFn",
  };
  const span = startSpan({
    event: {
      input: processInputAttachments(normalizePiContextInput(context)),
      metadata,
    },
    name: getLlmSpanName(model),
    parent: await state.span.export(),
    spanAttributes: { type: SpanTypeAttribute.LLM },
  });
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
      return Promise.resolve(Reflect.apply(originalResult, this, [])).then(
        (message) => {
          finishPiLlmSpan(promptState, llmState, message);
          return message;
        },
        (error) => {
          finishPiLlmSpan(promptState, llmState, undefined, error);
          throw error;
        },
      );
    };
  }

  const originalIterator = stream[Symbol.asyncIterator];
  if (typeof originalIterator === "function") {
    streamRecord[Symbol.asyncIterator] = async function* patchedPiIterator(
      this: PiAssistantMessageEventStream,
    ) {
      try {
        const iterator = Reflect.apply(
          originalIterator,
          this,
          [],
        ) as AsyncIterator<PiAssistantMessageEvent>;
        while (true) {
          const result = await iterator.next();
          if (result.done) {
            return;
          }
          const event = result.value;
          recordFirstTokenMetric(llmState, event);
          yield event;
        }
      } catch (error) {
        finishPiLlmSpan(promptState, llmState, undefined, error);
        throw error;
      }
    };
  }

  return stream;
}

function recordFirstTokenMetric(
  state: PiLlmSpanState,
  event: PiAssistantMessageEvent,
): void {
  if (
    state.metrics.time_to_first_token !== undefined ||
    event.type === "start"
  ) {
    return;
  }

  state.metrics.time_to_first_token =
    getCurrentUnixTimestamp() - state.startTime;
}

async function handlePiAgentEvent(
  state: PiPromptState,
  event: PiAgentEvent,
): Promise<void> {
  switch (event.type) {
    case "message_end":
      if (isPiAssistantMessage(event.message)) {
        state.output = extractAssistantOutput(event.message);
      }
      return;
    case "turn_end":
      if (isPiAssistantMessage(event.message)) {
        state.output = extractAssistantOutput(event.message);
        addMetrics(state.metrics, extractUsageMetrics(event.message.usage));
      }
      return;
    case "tool_execution_start":
      await startPiToolSpan(state, event);
      return;
    case "tool_execution_end":
      finishPiToolSpan(state, event);
      return;
    default:
      return;
  }
}

async function startPiToolSpan(
  state: PiPromptState,
  event: Extract<PiAgentEvent, { type: "tool_execution_start" }>,
): Promise<void> {
  if (!event.toolCallId || state.activeToolSpans.has(event.toolCallId)) {
    return;
  }

  const metadata = {
    "gen_ai.tool.call.id": event.toolCallId,
    "gen_ai.tool.name": event.toolName,
    "pi_coding_agent.tool.name": event.toolName,
  };
  const span = startSpan({
    event: {
      input: event.args,
      metadata,
    },
    name: event.toolName || "tool",
    parent: await state.span.export(),
    spanAttributes: { type: SpanTypeAttribute.TOOL },
  });
  state.activeToolSpans.set(event.toolCallId, span);
}

function finishPiToolSpan(
  state: PiPromptState,
  event: Extract<PiAgentEvent, { type: "tool_execution_end" }>,
): void {
  const span = state.activeToolSpans.get(event.toolCallId);
  if (!span) {
    return;
  }

  state.activeToolSpans.delete(event.toolCallId);
  const metadata = {
    "gen_ai.tool.call.id": event.toolCallId,
    "gen_ai.tool.name": event.toolName,
    "pi_coding_agent.tool.name": event.toolName,
    "pi_coding_agent.tool.is_error": event.isError,
  };
  try {
    safeLog(span, {
      ...(event.isError ? { error: stringifyUnknown(event.result) } : {}),
      metadata,
      output: event.result,
    });
  } finally {
    span.end();
  }
}

async function finalizePiPromptRun(
  state: PiPromptState,
  error?: unknown,
): Promise<void> {
  if (state.finalized) {
    return;
  }
  state.finalized = true;
  restorePiStreamFn(state);

  try {
    state.unsubscribeAgent?.();
  } catch (unsubscribeError) {
    logInstrumentationError("Pi Coding Agent unsubscribe", unsubscribeError);
  }

  await finishOpenLlmSpans(state, error);
  finishOpenToolSpans(state, error);

  const metadata = {
    ...state.metadata,
    ...extractModelMetadata(state.agent.state?.model),
  };
  try {
    safeLog(state.span, {
      ...(error ? { error: stringifyUnknown(error) } : {}),
      metadata,
      metrics: {
        ...cleanMetrics(state.metrics),
        ...buildDurationMetrics(state.startTime),
      },
      output: state.output,
    });
  } finally {
    state.span.end();
  }
}

function restorePiStreamFn(state: PiPromptState): void {
  if (state.agent.streamFn === state.wrappedStreamFn) {
    state.agent.streamFn = state.originalStreamFn;
  }
}

async function finishOpenLlmSpans(
  state: PiPromptState,
  error?: unknown,
): Promise<void> {
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

  const messageError = message?.stopReason === "error" && message.errorMessage;
  const metrics = {
    ...extractUsageMetrics(message?.usage),
    ...cleanMetrics(llmState.metrics),
    ...buildDurationMetrics(llmState.startTime),
  };
  addMetrics(promptState.metrics, extractUsageMetrics(message?.usage));

  try {
    safeLog(llmState.span, {
      ...(error || messageError
        ? { error: stringifyUnknown(error ?? messageError) }
        : {}),
      metadata: {
        ...llmState.metadata,
        ...(message ? extractAssistantMetadata(message) : {}),
      },
      metrics,
      ...(message ? { output: extractAssistantOutput(message) } : {}),
    });
  } finally {
    llmState.span.end();
  }
}

function finishOpenToolSpans(state: PiPromptState, error?: unknown): void {
  for (const [, span] of state.activeToolSpans) {
    safeLog(span, {
      error: error ? stringifyUnknown(error) : "Pi tool did not complete",
    });
    span.end();
  }
  state.activeToolSpans.clear();
}

function normalizePiContextInput(context: PiContext): unknown[] {
  const messages = context.messages.flatMap((message) =>
    normalizePiMessage(message),
  );
  if (context.systemPrompt) {
    return [{ role: "system", content: context.systemPrompt }, ...messages];
  }
  return messages;
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
    ...(thinking ? { reasoning: thinking } : {}),
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
          url: `data:${part.mimeType};base64,${part.data}`,
        },
      };
    }
    return part;
  });
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

function extractAssistantOutput(message: PiAssistantMessage): unknown {
  return processInputAttachments([
    {
      finish_reason: normalizeStopReason(message.stopReason),
      index: 0,
      message: normalizeAssistantMessage(message),
    },
  ]);
}

function isPiUserMessage(
  message: PiMessage,
): message is Extract<PiMessage, { role: "user" }> {
  return message.role === "user" && "content" in message;
}

function isPiAssistantMessage(
  message: PiMessage,
): message is PiAssistantMessage {
  return (
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
  return processInputAttachments([
    {
      role: "user",
      content: [
        { type: "text", text: text ?? "" },
        ...images.map((image) => ({
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType};base64,${image.data}`,
          },
        })),
      ],
    },
  ]);
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
): Record<string, unknown> {
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
    ...(options.metadata
      ? { "pi_coding_agent.metadata": options.metadata }
      : {}),
  };
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

  return cleanMetrics({
    completion_tokens: usage.output,
    prompt_cache_creation_tokens: usage.cacheWrite,
    prompt_cached_tokens: usage.cacheRead,
    prompt_tokens: usage.input,
    tokens: usage.totalTokens ?? usage.tokens,
  });
}

function addMetrics(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
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

function cleanMetrics(
  metrics: Record<string, unknown>,
): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
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

function safeLog(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    logInstrumentationError("Pi Coding Agent span log", error);
  }
}

function logInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`${context}:`, error);
}
