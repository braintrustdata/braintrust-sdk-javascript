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
  activeItemSpans: Map<string, Span>;
  completedItems: OpenAICodexThreadItem[];
  finalResponse?: string;
  finalized: boolean;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  outputText: string[];
  span: Span;
  startTime: number;
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
      asyncEnd: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        void finalizeCompletedRun(state, event.result);
      },
      error: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        void finalizeCodexRun(state, { error: event.error });
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
      asyncEnd: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        patchStreamedTurn(event.result, state);
      },
      error: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }
        states.delete(event);
        void finalizeCodexRun(state, { error: event.error });
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
    input: sanitizeInput(input),
    metadata,
  });

  return {
    activeItemSpans: new Map(),
    completedItems: [],
    finalized: false,
    metadata,
    metrics: {},
    outputText: [],
    span,
    startTime,
  };
}

function patchStreamedTurn(
  streamedTurn: OpenAICodexStreamedTurn | undefined,
  state: CodexRunState,
): void {
  if (!streamedTurn || typeof streamedTurn !== "object") {
    void finalizeCodexRun(state, { output: streamedTurn });
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
    void finalizeCodexRun(state, { output: streamedTurn });
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
      await startCodexItemSpan(state, event.item);
      return;
    case "item.updated":
      updateCodexItem(state, event.item);
      return;
    case "item.completed":
      state.completedItems.push(event.item);
      collectOutputText(state, event.item);
      await finishCodexItemSpan(state, event.item);
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
    state.completedItems.push(item);
    collectOutputText(state, item);
    await createCompletedItemSpan(state, item);
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
  if (usage.input_tokens !== undefined) {
    metrics.prompt_tokens = usage.input_tokens;
  }
  if (usage.cached_input_tokens !== undefined) {
    metrics.prompt_cached_tokens = usage.cached_input_tokens;
  }
  if (usage.output_tokens !== undefined) {
    metrics.completion_tokens = usage.output_tokens;
  }
  if (usage.reasoning_output_tokens !== undefined) {
    metrics.completion_reasoning_tokens = usage.reasoning_output_tokens;
  }

  metrics.tokens =
    (metrics.prompt_tokens ?? 0) +
    (metrics.completion_tokens ?? 0) +
    (metrics.prompt_cached_tokens ?? 0) +
    (metrics.completion_reasoning_tokens ?? 0);
  return metrics;
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
