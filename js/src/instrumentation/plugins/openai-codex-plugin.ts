import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers } from "../../isomorph";
import { debugLogger } from "../../debug-logger";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp } from "../../util";
import { SpanTypeAttribute } from "../../../util/index";
import { openAICodexChannels } from "./openai-codex-channels";
import type {
  OpenAICodexCommandExecutionItem,
  OpenAICodexFileChangeItem,
  OpenAICodexInput,
  OpenAICodexMcpToolCallItem,
  OpenAICodexStreamedTurn,
  OpenAICodexThread,
  OpenAICodexThreadEvent,
  OpenAICodexThreadItem,
  OpenAICodexThreadOptions,
  OpenAICodexTurn,
  OpenAICodexTurnOptions,
  OpenAICodexUsage,
  OpenAICodexWebSearchItem,
} from "../../vendor-sdk-types/openai-codex";

type CodexRunState = {
  activeLlmSpan?: CodexLlmSpanState;
  activeItemSpans: Map<string, Span>;
  completedItems: OpenAICodexThreadItem[];
  finalResponse?: string;
  finalized: boolean;
  input: unknown;
  llmSequence: number;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  outputText: string[];
  span: Span;
  startTime: number;
};

type CodexLlmSpanState = {
  anonymousMessages: string[];
  anonymousReasoning: string[];
  messagesById: Map<string, string>;
  metadata: Record<string, unknown>;
  reasoningById: Map<string, string>;
  span: Span;
};

const PATCHED_STREAMED_TURN = Symbol.for(
  "braintrust.openai-codex.patched-streamed-turn",
);

export class OpenAICodexPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToRun();
    this.subscribeToRunStreamed();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToRun(): void {
    const channel = openAICodexChannels.run.tracingChannel();
    const states = new WeakMap<object, CodexRunState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof openAICodexChannels.run>
    > = {
      start: (event) => {
        states.set(event, startCodexRun(event, "Thread.run"));
      },
      asyncEnd: async (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        await finalizeCompletedRun(state, event.result);
      },
      error: async (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        await finalizeCodexRun(state, { error: event.error });
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }

  private subscribeToRunStreamed(): void {
    const channel = openAICodexChannels.runStreamed.tracingChannel();
    const states = new WeakMap<object, CodexRunState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof openAICodexChannels.runStreamed>
    > = {
      start: (event) => {
        states.set(event, startCodexRun(event, "Thread.runStreamed"));
      },
      asyncEnd: async (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        await patchStreamedTurn(event.result, state);
      },
      error: async (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        await finalizeCodexRun(state, { error: event.error });
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }
}

function startCodexRun(
  event: ChannelMessage<
    typeof openAICodexChannels.run | typeof openAICodexChannels.runStreamed
  >,
  operation: "Thread.run" | "Thread.runStreamed",
): CodexRunState {
  const input = event.arguments[0];
  const turnOptions = event.arguments[1];
  const thread = event.thread ?? extractThreadFromEvent(event);
  const sanitizedInput = sanitizeInput(input);
  const metadata = {
    ...extractThreadMetadata(thread),
    ...extractTurnOptionsMetadata(turnOptions),
    "openai_codex.operation": operation,
    provider: "openai",
    ...(event.moduleVersion
      ? { "openai_codex.version": event.moduleVersion }
      : {}),
  };
  const span = startSpan({
    name: "OpenAI Codex",
    spanAttributes: { type: SpanTypeAttribute.TASK },
  });
  const startTime = getCurrentUnixTimestamp();
  safeLog(span, {
    input: sanitizedInput,
    metadata,
  });

  return {
    activeItemSpans: new Map(),
    completedItems: [],
    finalized: false,
    input: sanitizedInput,
    llmSequence: 0,
    metadata,
    metrics: {},
    outputText: [],
    span,
    startTime,
  };
}

async function patchStreamedTurn(
  streamedTurn: OpenAICodexStreamedTurn | undefined,
  state: CodexRunState,
): Promise<void> {
  if (!streamedTurn || typeof streamedTurn !== "object") {
    await finalizeCodexRun(state, { output: streamedTurn });
    return;
  }

  const turnRecord = streamedTurn as OpenAICodexStreamedTurn &
    Record<PropertyKey, unknown>;
  if (
    turnRecord[PATCHED_STREAMED_TURN] ||
    !isAsyncIterable(turnRecord.events)
  ) {
    return;
  }

  try {
    Object.defineProperty(turnRecord, PATCHED_STREAMED_TURN, {
      configurable: false,
      enumerable: false,
      value: true,
    });
    turnRecord.events = patchCodexEventStream(turnRecord.events, state);
  } catch {
    await finalizeCodexRun(state, { output: streamedTurn });
  }
}

async function* patchCodexEventStream(
  events: AsyncGenerator<OpenAICodexThreadEvent>,
  state: CodexRunState,
): AsyncGenerator<OpenAICodexThreadEvent> {
  try {
    for await (const event of events) {
      try {
        await handleCodexEvent(state, event);
      } catch (error) {
        logInstrumentationError("OpenAI Codex stream event", error);
      }
      yield event;
    }
    await finalizeCodexRun(state);
  } catch (error) {
    await finalizeCodexRun(state, { error });
    throw error;
  }
}

async function handleCodexEvent(
  state: CodexRunState,
  event: OpenAICodexThreadEvent,
): Promise<void> {
  switch (event.type) {
    case "thread.started":
      state.metadata["openai_codex.thread_id"] = event.thread_id;
      return;
    case "turn.completed":
      Object.assign(state.metrics, extractUsageMetrics(event.usage));
      return;
    case "turn.failed":
      await finalizeCodexRun(state, {
        error: event.error?.message ?? "Codex turn failed",
      });
      return;
    case "item.started":
      await handleCodexItemStarted(state, event.item);
      return;
    case "item.updated":
      await handleCodexItemUpdated(state, event.item);
      return;
    case "item.completed":
      await handleCodexItemCompleted(state, event.item);
      return;
    case "error":
      await finalizeCodexRun(state, { error: event.message });
      return;
    default:
      return;
  }
}

async function finalizeCompletedRun(
  state: CodexRunState,
  turn: OpenAICodexTurn | undefined,
): Promise<void> {
  if (!turn) {
    await finalizeCodexRun(state, { output: turn });
    return;
  }

  Object.assign(state.metrics, extractUsageMetrics(turn.usage));
  state.finalResponse = turn.finalResponse;

  for (const item of turn.items ?? []) {
    await handleCodexItemCompleted(state, item);
  }

  await finalizeCodexRun(state, { output: turn.finalResponse });
}

async function finalizeCodexRun(
  state: CodexRunState,
  params: {
    error?: unknown;
    output?: unknown;
  } = {},
): Promise<void> {
  if (state.finalized) {
    return;
  }
  state.finalized = true;

  const output =
    params.output ??
    state.finalResponse ??
    (state.outputText.length > 0 ? state.outputText.join("\n") : undefined);
  const metrics = {
    ...cleanMetrics(state.metrics),
    ...buildDurationMetrics(state.startTime),
  };

  await finishActiveLlmSpan(state, params.error);

  try {
    const error = params.error;
    safeLog(state.span, {
      ...(error
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
      metadata: state.metadata,
      metrics,
      output,
    });
  } finally {
    endOpenItemSpans(state);
    state.span.end();
  }
}

async function handleCodexItemStarted(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): Promise<void> {
  if (isCodexToolItem(item)) {
    await finishActiveLlmSpan(state);
    await startCodexItemSpan(state, item);
    return;
  }

  await recordCodexLlmItem(state, item, { allowAnonymousText: false });
}

async function handleCodexItemUpdated(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): Promise<void> {
  updateCodexItem(state, item);
  await recordCodexLlmItem(state, item, { allowAnonymousText: false });
}

async function handleCodexItemCompleted(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): Promise<void> {
  state.completedItems.push(item);
  collectOutputText(state, item);

  if (isCodexToolItem(item)) {
    await finishActiveLlmSpan(state);
    await finishCodexItemSpan(state, item);
    return;
  }

  await recordCodexLlmItem(state, item, { allowAnonymousText: true });
}

async function createCompletedItemSpan(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): Promise<void> {
  const spanArgs = await itemSpanArgs(state, item);
  if (!spanArgs) {
    return;
  }

  const span = startSpan(spanArgs.start);
  safeLog(span, spanArgs.end);
  span.end();
}

async function recordCodexLlmItem(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
  options: { allowAnonymousText: boolean },
): Promise<void> {
  if (item.type !== "agent_message" && item.type !== "reasoning") {
    return;
  }

  const text = typeof item.text === "string" ? item.text : undefined;
  const active = await ensureActiveLlmSpan(state);
  if (!text) {
    return;
  }

  if (item.type === "agent_message") {
    if (item.id) {
      active.messagesById.set(item.id, text);
    } else if (options.allowAnonymousText) {
      active.anonymousMessages.push(text);
    }
  } else if (item.id) {
    active.reasoningById.set(item.id, text);
  } else if (options.allowAnonymousText) {
    active.anonymousReasoning.push(text);
  }
}

async function ensureActiveLlmSpan(
  state: CodexRunState,
): Promise<CodexLlmSpanState> {
  if (state.activeLlmSpan) {
    return state.activeLlmSpan;
  }

  const sequence = state.llmSequence + 1;
  state.llmSequence = sequence;
  const metadata = {
    ...(state.metadata.provider ? { provider: state.metadata.provider } : {}),
    ...(state.metadata.model ? { model: state.metadata.model } : {}),
    ...(state.metadata["openai_codex.model"]
      ? { "openai_codex.model": state.metadata["openai_codex.model"] }
      : {}),
    ...(state.metadata["openai_codex.model_reasoning_effort"]
      ? {
          "openai_codex.model_reasoning_effort":
            state.metadata["openai_codex.model_reasoning_effort"],
        }
      : {}),
    ...(state.metadata["openai_codex.operation"]
      ? { "openai_codex.operation": state.metadata["openai_codex.operation"] }
      : {}),
    ...(state.metadata["openai_codex.thread_id"]
      ? { "openai_codex.thread_id": state.metadata["openai_codex.thread_id"] }
      : {}),
    "openai_codex.llm_sequence": sequence,
  };

  const span = startSpan({
    event: {
      ...(sequence === 1 ? { input: state.input } : {}),
      metadata,
    },
    name: "OpenAI Codex LLM",
    parent: await state.span.export(),
    spanAttributes: { type: SpanTypeAttribute.LLM },
  });

  state.activeLlmSpan = {
    anonymousMessages: [],
    anonymousReasoning: [],
    messagesById: new Map(),
    metadata,
    reasoningById: new Map(),
    span,
  };
  return state.activeLlmSpan;
}

async function finishActiveLlmSpan(
  state: CodexRunState,
  error?: unknown,
): Promise<void> {
  const active = state.activeLlmSpan;
  if (!active) {
    return;
  }

  state.activeLlmSpan = undefined;
  const output = buildLlmOutput(active);
  safeLog(active.span, {
    ...(error
      ? { error: error instanceof Error ? error.message : String(error) }
      : {}),
    metadata: active.metadata,
    ...(output ? { output } : {}),
  });
  active.span.end();
}

function buildLlmOutput(
  active: CodexLlmSpanState,
): Record<string, string> | undefined {
  const reasoning = [
    ...active.reasoningById.values(),
    ...active.anonymousReasoning,
  ]
    .filter((text) => text.length > 0)
    .join("\n");
  const message = [...active.messagesById.values(), ...active.anonymousMessages]
    .filter((text) => text.length > 0)
    .join("\n");
  const output = {
    ...(reasoning ? { reasoning } : {}),
    ...(message ? { message } : {}),
  };

  return Object.keys(output).length > 0 ? output : undefined;
}

async function startCodexItemSpan(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): Promise<void> {
  const itemId = item.id;
  if (!itemId || state.activeItemSpans.has(itemId)) {
    return;
  }
  const spanArgs = await itemSpanArgs(state, item);
  if (!spanArgs) {
    return;
  }
  state.activeItemSpans.set(itemId, startSpan(spanArgs.start));
}

function updateCodexItem(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): void {
  if (item.type === "agent_message" && typeof item.text === "string") {
    state.finalResponse = item.text;
  }
}

async function finishCodexItemSpan(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): Promise<void> {
  const itemId = item.id;
  if (!itemId) {
    await createCompletedItemSpan(state, item);
    return;
  }

  const span = state.activeItemSpans.get(itemId);
  if (!span) {
    await createCompletedItemSpan(state, item);
    return;
  }

  state.activeItemSpans.delete(itemId);
  const spanArgs = await itemSpanArgs(state, item);
  if (spanArgs) {
    safeLog(span, spanArgs.end);
  }
  span.end();
}

function isCodexToolItem(item: OpenAICodexThreadItem): boolean {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  );
}

async function itemSpanArgs(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): Promise<
  | {
      start: Parameters<typeof startSpan>[0];
      end: Parameters<Span["log"]>[0];
    }
  | undefined
> {
  const parent = await state.span.export();
  const baseMetadata = {
    "openai_codex.item_id": item.id,
    "openai_codex.item_type": item.type,
  };

  switch (item.type) {
    case "command_execution":
      return commandSpanArgs(parent, baseMetadata, item);
    case "mcp_tool_call":
      return mcpToolSpanArgs(parent, baseMetadata, item);
    case "web_search":
      return webSearchSpanArgs(parent, baseMetadata, item);
    case "file_change":
      return fileChangeSpanArgs(parent, baseMetadata, item);
    default:
      return undefined;
  }
}

function commandSpanArgs(
  parent: string,
  baseMetadata: Record<string, unknown>,
  item: OpenAICodexCommandExecutionItem,
) {
  const metadata = {
    ...baseMetadata,
    "gen_ai.tool.name": "command_execution",
    "openai_codex.command.exit_code": item.exit_code,
    "openai_codex.command.status": item.status,
  };
  return {
    start: {
      event: { input: item.command, metadata },
      name: "tool: command_execution",
      parent,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    },
    end: {
      ...(item.status === "failed"
        ? { error: item.aggregated_output || "Command execution failed" }
        : {}),
      metadata,
      output: item.aggregated_output,
    },
  };
}

function mcpToolSpanArgs(
  parent: string,
  baseMetadata: Record<string, unknown>,
  item: OpenAICodexMcpToolCallItem,
) {
  const toolName = item.tool || "mcp_tool_call";
  const metadata = {
    ...baseMetadata,
    "gen_ai.tool.name": toolName,
    "openai_codex.mcp.server": item.server,
    "openai_codex.mcp.status": item.status,
  };
  return {
    start: {
      event: {
        input: {
          arguments: item.arguments,
          server: item.server,
          tool: item.tool,
        },
        metadata,
      },
      name: `tool: ${toolName}`,
      parent,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    },
    end: {
      ...(item.error?.message ? { error: item.error.message } : {}),
      metadata,
      output: item.result,
    },
  };
}

function webSearchSpanArgs(
  parent: string,
  baseMetadata: Record<string, unknown>,
  item: OpenAICodexWebSearchItem,
) {
  const metadata = {
    ...baseMetadata,
    "gen_ai.tool.name": "web_search",
  };
  return {
    start: {
      event: { input: item.query, metadata },
      name: "tool: web_search",
      parent,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    },
    end: { metadata },
  };
}

function fileChangeSpanArgs(
  parent: string,
  baseMetadata: Record<string, unknown>,
  item: OpenAICodexFileChangeItem,
) {
  const metadata = {
    ...baseMetadata,
    "gen_ai.tool.name": "file_change",
    "openai_codex.file_change.status": item.status,
  };
  return {
    start: {
      event: { input: item.changes, metadata },
      name: "tool: file_change",
      parent,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    },
    end: {
      ...(item.status === "failed" ? { error: "File change failed" } : {}),
      metadata,
      output: item.changes,
    },
  };
}

function endOpenItemSpans(state: CodexRunState): void {
  for (const [, span] of state.activeItemSpans) {
    safeLog(span, { error: "Codex item did not complete" });
    span.end();
  }
  state.activeItemSpans.clear();
}

function collectOutputText(
  state: CodexRunState,
  item: OpenAICodexThreadItem,
): void {
  if (item.type === "agent_message" && typeof item.text === "string") {
    state.finalResponse = item.text;
    state.outputText.push(item.text);
  } else if (
    item.type === "reasoning" &&
    typeof item.text === "string" &&
    !state.finalResponse
  ) {
    state.outputText.push(item.text);
  }
}

function extractThreadFromEvent(
  event: ChannelMessage<
    typeof openAICodexChannels.run | typeof openAICodexChannels.runStreamed
  >,
): OpenAICodexThread | undefined {
  return event.self && typeof event.self === "object"
    ? (event.self as OpenAICodexThread)
    : undefined;
}

function extractThreadMetadata(
  thread: OpenAICodexThread | undefined,
): Record<string, unknown> {
  const threadOptions = extractThreadOptions(thread);
  return {
    ...(thread?.id ? { "openai_codex.thread_id": thread.id } : {}),
    ...extractThreadOptionsMetadata(threadOptions),
  };
}

function extractThreadOptions(
  thread: OpenAICodexThread | undefined,
): OpenAICodexThreadOptions | undefined {
  if (!thread || typeof thread !== "object") {
    return undefined;
  }
  const value = Reflect.get(thread, "_threadOptions");
  return value && typeof value === "object"
    ? (value as OpenAICodexThreadOptions)
    : undefined;
}

function extractThreadOptionsMetadata(
  options: OpenAICodexThreadOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {};
  }

  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.model ? { "openai_codex.model": options.model } : {}),
    ...(options.sandboxMode
      ? { "openai_codex.sandbox_mode": options.sandboxMode }
      : {}),
    ...(options.workingDirectory
      ? { "openai_codex.working_directory": options.workingDirectory }
      : {}),
    ...(options.skipGitRepoCheck !== undefined
      ? { "openai_codex.skip_git_repo_check": options.skipGitRepoCheck }
      : {}),
    ...(options.modelReasoningEffort
      ? {
          "openai_codex.model_reasoning_effort": options.modelReasoningEffort,
        }
      : {}),
    ...(options.networkAccessEnabled !== undefined
      ? {
          "openai_codex.network_access_enabled": options.networkAccessEnabled,
        }
      : {}),
    ...(options.webSearchMode
      ? { "openai_codex.web_search_mode": options.webSearchMode }
      : {}),
    ...(options.webSearchEnabled !== undefined
      ? { "openai_codex.web_search_enabled": options.webSearchEnabled }
      : {}),
    ...(options.approvalPolicy
      ? { "openai_codex.approval_policy": options.approvalPolicy }
      : {}),
    ...(options.additionalDirectories
      ? {
          "openai_codex.additional_directories": options.additionalDirectories,
        }
      : {}),
  };
}

function extractTurnOptionsMetadata(
  options: OpenAICodexTurnOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {};
  }

  return {
    ...(options.outputSchema !== undefined
      ? { "openai_codex.output_schema": true }
      : {}),
  };
}

function sanitizeInput(input: OpenAICodexInput): unknown {
  if (typeof input === "string") {
    return input;
  }

  return input.map((item) => {
    if (item.type === "local_image") {
      return {
        path: item.path,
        type: "local_image",
      };
    }
    return item;
  });
}

function extractUsageMetrics(
  usage: OpenAICodexUsage | null | undefined,
): Record<string, number> {
  if (!usage) {
    return {};
  }

  const metrics: Record<string, number> = {};
  const promptTokens = firstNumber(usage.prompt_tokens, usage.input_tokens);
  if (promptTokens !== undefined) {
    metrics.prompt_tokens = promptTokens;
  }

  const promptCachedTokens = firstNumber(
    usage.prompt_cached_tokens,
    usage.cached_input_tokens,
  );
  if (promptCachedTokens !== undefined) {
    metrics.prompt_cached_tokens = promptCachedTokens;
  }

  const completionTokens = firstNumber(
    usage.completion_tokens,
    usage.output_tokens,
  );
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }

  const completionReasoningTokens = firstNumber(
    usage.completion_reasoning_tokens,
    usage.reasoning_output_tokens,
  );
  if (completionReasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = completionReasoningTokens;
  }

  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.tokens,
    usage.total_tokens,
  );
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  }

  return metrics;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
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
    if (value !== undefined && Number.isFinite(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function isAsyncIterable(value: unknown): value is AsyncGenerator<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

function safeLog(span: Span, event: Parameters<Span["log"]>[0]): void {
  try {
    span.log(event);
  } catch (error) {
    logInstrumentationError("OpenAI Codex span log", error);
  }
}

function logInstrumentationError(context: string, error: unknown): void {
  debugLogger.error(`Error processing ${context}:`, error);
}
