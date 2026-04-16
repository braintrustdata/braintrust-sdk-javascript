import { BasePlugin } from "../core";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import { Attachment, startSpan, withCurrent } from "../../logger";
import type { Span } from "../../logger";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import {
  SpanTypeAttribute,
  isObject,
  isPromiseLike,
} from "../../../util/index";
import { filterFrom, getCurrentUnixTimestamp } from "../../util";
import { finalizeAnthropicTokens } from "../../wrappers/anthropic-tokens-util";
import { anthropicChannels } from "./anthropic-channels";
import type {
  AnthropicBase64Source,
  AnthropicCitation,
  AnthropicCreateParams,
  AnthropicInputMessage,
  AnthropicMessage,
  AnthropicMessageStream,
  AnthropicOutputContentBlock,
  AnthropicStreamEvent,
  AnthropicToolRunner,
  AnthropicToolRunnerParams,
  AnthropicToolRunnerTool,
  AnthropicUsage,
} from "../../vendor-sdk-types/anthropic";

type AnthropicToolRunnerState = {
  aggregatedMetrics: Record<string, number>;
  finalized: boolean;
  firstTokenTime?: number;
  iterationCount: number;
  lastMessage?: AnthropicMessage;
  seenMessages: WeakSet<object>;
  span: Span;
  startTime: number;
};

const ANTHROPIC_TOOL_RUNNER_TOOL_WRAPPED = Symbol.for(
  "braintrust.anthropic_tool_runner_tool_wrapped",
);

/**
 * Auto-instrumentation plugin for the Anthropic SDK.
 *
 * This plugin subscribes to orchestrion channels for Anthropic SDK methods
 * and creates Braintrust spans to track:
 * - messages.create (streaming and non-streaming)
 * - beta.messages.create (streaming and non-streaming)
 *
 * The plugin handles:
 * - Anthropic-specific token metrics (including cache tokens)
 * - Processing message streams
 * - Converting base64 attachments to Attachment objects
 * - Streaming and non-streaming responses
 */
export class AnthropicPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToAnthropicChannels();
    this.subscribeToAnthropicToolRunner();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToAnthropicChannels(): void {
    const anthropicConfig = {
      name: "anthropic.messages.create",
      type: SpanTypeAttribute.LLM,
      extractInput: (args: unknown[]) => {
        const params = (args[0] || {}) as AnthropicCreateParams;
        const input = coalesceInput(params.messages || [], params.system);
        const metadata = filterFrom(params, ["messages", "system"]);
        return {
          input: processAttachmentsInInput(input),
          metadata: { ...metadata, provider: "anthropic" },
        };
      },
      extractOutput: (message: AnthropicMessage) => {
        return message
          ? { role: message.role, content: message.content }
          : null;
      },
      extractMetrics: (message: AnthropicMessage, startTime?: number) => {
        const metrics = parseMetricsFromUsage(message?.usage);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        const finalized = finalizeAnthropicTokens(metrics);
        // Filter out undefined values to match Record<string, number> type
        return Object.fromEntries(
          Object.entries(finalized).filter(
            (entry): entry is [string, number] => entry[1] !== undefined,
          ),
        );
      },
      extractMetadata: (message: AnthropicMessage) => {
        const metadata: Record<string, unknown> = {};
        const metas = ["stop_reason", "stop_sequence"] as const;
        for (const m of metas) {
          if (message?.[m] !== undefined) {
            metadata[m] = message[m];
          }
        }
        return metadata;
      },
      aggregateChunks: (chunks: AnthropicStreamEvent[]) =>
        aggregateAnthropicStreamChunks(chunks),
    };

    // Messages API - supports streaming via stream=true parameter
    this.unsubscribers.push(
      traceStreamingChannel(anthropicChannels.messagesCreate, anthropicConfig),
    );

    // Beta Messages API - supports streaming via stream=true parameter
    this.unsubscribers.push(
      traceStreamingChannel(anthropicChannels.betaMessagesCreate, {
        ...anthropicConfig,
        name: "anthropic.messages.create",
      }),
    );
  }

  private subscribeToAnthropicToolRunner(): void {
    const tracingChannel =
      anthropicChannels.betaMessagesToolRunner.tracingChannel() as IsoTracingChannel<
        ChannelMessage<typeof anthropicChannels.betaMessagesToolRunner>
      >;
    const states = new WeakMap<object, AnthropicToolRunnerState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof anthropicChannels.betaMessagesToolRunner>
    > = {
      start: (event) => {
        const params = (event.arguments[0] ?? {}) as AnthropicToolRunnerParams;
        const span = startSpan({
          name: "anthropic.beta.messages.toolRunner",
          spanAttributes: {
            type: SpanTypeAttribute.TASK,
          },
        });

        span.log({
          input: processAttachmentsInInput(
            coalesceInput(params.messages ?? [], params.system),
          ),
          metadata: {
            ...extractAnthropicToolRunnerMetadata(params),
            provider: "anthropic",
          },
        });

        const state = {
          aggregatedMetrics: {},
          finalized: false,
          iterationCount: 0,
          seenMessages: new WeakSet<object>(),
          span,
          startTime: getCurrentUnixTimestamp(),
        } satisfies AnthropicToolRunnerState;

        states.set(event as object, state);
      },

      end: (event) => {
        const state = states.get(event as object);
        if (!state) {
          return;
        }

        patchAnthropicToolRunner({
          runner: event.result as AnthropicToolRunner<unknown>,
          state,
        });
      },

      error: (event) => {
        const state = states.get(event as object);
        if (!state || !event.error) {
          return;
        }

        finalizeAnthropicToolRunnerError(state, event.error);
        states.delete(event as object);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }
}

/**
 * Parse metrics from Anthropic usage object.
 * Maps Anthropic's token names to Braintrust's standard names.
 */
export function parseMetricsFromUsage(
  usage: AnthropicUsage | undefined,
): Record<string, number> {
  if (!usage) {
    return {};
  }

  const metrics: Record<string, number> = {};

  function saveIfExistsTo(source: keyof AnthropicUsage, target: string) {
    const value = usage![source];
    if (value !== undefined && value !== null && typeof value === "number") {
      metrics[target] = value;
    }
  }

  saveIfExistsTo("input_tokens", "prompt_tokens");
  saveIfExistsTo("output_tokens", "completion_tokens");
  saveIfExistsTo("cache_read_input_tokens", "prompt_cached_tokens");
  saveIfExistsTo("cache_creation_input_tokens", "prompt_cache_creation_tokens");

  if (isObject(usage.server_tool_use)) {
    for (const [name, value] of Object.entries(usage.server_tool_use)) {
      if (typeof value === "number") {
        metrics[`server_tool_use_${name}`] = value;
      }
    }
  }

  return metrics;
}

function extractAnthropicToolRunnerMetadata(
  params: AnthropicToolRunnerParams,
): Record<string, unknown> {
  const metadata = filterFrom(params, ["messages", "system", "tools"]);
  const toolNames = extractAnthropicToolNames(params.tools);

  return {
    ...metadata,
    operation: "toolRunner",
    ...(toolNames.length > 0 ? { tool_names: toolNames } : {}),
  };
}

function extractAnthropicToolNames(tools: unknown[]): string[] {
  const toolNames: string[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }

    const toolRecord = tool as {
      mcp_server_name?: unknown;
      name?: unknown;
    };

    if (typeof toolRecord.name === "string") {
      toolNames.push(toolRecord.name);
      continue;
    }

    if (typeof toolRecord.mcp_server_name === "string") {
      toolNames.push(toolRecord.mcp_server_name);
    }
  }

  return toolNames;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrapAnthropicToolRunnerTools(
  params: AnthropicToolRunnerParams,
  state: AnthropicToolRunnerState,
): void {
  if (!Array.isArray(params.tools)) {
    return;
  }

  params.tools = params.tools.map((tool, index) =>
    wrapAnthropicToolRunnerTool(tool, index, state),
  );
}

function wrapAnthropicToolRunnerTool(
  tool: AnthropicToolRunnerTool,
  index: number,
  state: AnthropicToolRunnerState,
): AnthropicToolRunnerTool {
  if (
    !tool ||
    typeof tool !== "object" ||
    typeof tool.run !== "function" ||
    (
      tool as AnthropicToolRunnerTool & {
        [ANTHROPIC_TOOL_RUNNER_TOOL_WRAPPED]?: boolean;
      }
    )[ANTHROPIC_TOOL_RUNNER_TOOL_WRAPPED]
  ) {
    return tool;
  }

  const toolName = typeof tool.name === "string" ? tool.name : `tool[${index}]`;
  const originalRun = tool.run;
  const runDescriptor = Object.getOwnPropertyDescriptor(tool, "run");
  const wrappedTool = Object.create(
    Object.getPrototypeOf(tool),
    Object.getOwnPropertyDescriptors(tool),
  ) as AnthropicToolRunnerTool;

  Object.defineProperty(wrappedTool, "run", {
    configurable: runDescriptor?.configurable ?? true,
    enumerable: runDescriptor?.enumerable ?? true,
    value: function braintrustAnthropicToolRunnerRun(
      this: unknown,
      ...args: unknown[]
    ) {
      return state.span.traced(
        (span) => {
          const finalizeSuccess = (result: unknown) => {
            span.log({ output: result });
            return result;
          };

          const finalizeError = (error: unknown) => {
            span.log({ error: toErrorMessage(error) });
            throw error;
          };

          try {
            const result = Reflect.apply(originalRun, this, args);
            if (isPromiseLike(result)) {
              return result.then(finalizeSuccess, finalizeError);
            }
            return finalizeSuccess(result);
          } catch (error) {
            return finalizeError(error);
          }
        },
        {
          event: {
            input: args.length === 1 ? args[0] : args,
            metadata: {
              "gen_ai.tool.name": toolName,
              provider: "anthropic",
            },
          },
          name: `tool: ${toolName}`,
          spanAttributes: {
            type: SpanTypeAttribute.TOOL,
          },
        },
      );
    },
    writable: runDescriptor?.writable ?? true,
  });
  Object.defineProperty(wrappedTool, ANTHROPIC_TOOL_RUNNER_TOOL_WRAPPED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  return wrappedTool;
}

function getAnthropicToolRunnerParams(
  runnerRecord: Record<string, unknown>,
): AnthropicToolRunnerParams | undefined {
  const params = Reflect.get(runnerRecord, "params");
  return params && typeof params === "object"
    ? (params as AnthropicToolRunnerParams)
    : undefined;
}

function ensureAnthropicToolRunnerToolsWrapped(
  runnerRecord: Record<string, unknown>,
  state: AnthropicToolRunnerState,
): void {
  const params = getAnthropicToolRunnerParams(runnerRecord);
  if (params) {
    wrapAnthropicToolRunnerTools(params, state);
  }
}

function wrapAnthropicToolRunnerSetMessagesParams(
  runnerRecord: Record<string, unknown>,
  state: AnthropicToolRunnerState,
): void {
  const setMessagesParams = Reflect.get(runnerRecord, "setMessagesParams");
  if (typeof setMessagesParams !== "function") {
    return;
  }

  Reflect.set(
    runnerRecord,
    "setMessagesParams",
    function patchedSetMessagesParams(this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(setMessagesParams, this, args);
      const nextParams = getAnthropicToolRunnerParams(runnerRecord);
      if (nextParams) {
        wrapAnthropicToolRunnerTools(nextParams, state);
      }
      return result;
    },
  );
}

function isAnthropicMessage(value: unknown): value is AnthropicMessage {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { role?: unknown }).role === "string" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isAnthropicMessageStream(
  value: unknown,
): value is AnthropicMessageStream & Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    isAsyncIterable(value) &&
    "finalMessage" in value &&
    typeof (value as { finalMessage?: unknown }).finalMessage === "function"
  );
}

function recordAnthropicToolRunnerMessage(
  state: AnthropicToolRunnerState,
  message: AnthropicMessage,
): void {
  if (typeof message !== "object" || message === null) {
    return;
  }

  if (state.seenMessages.has(message as object)) {
    state.lastMessage = message;
    return;
  }

  state.seenMessages.add(message as object);
  state.lastMessage = message;

  const parsedMetrics = parseMetricsFromUsage(message.usage);
  for (const [key, value] of Object.entries(parsedMetrics)) {
    if (typeof value === "number") {
      state.aggregatedMetrics[key] =
        (state.aggregatedMetrics[key] ?? 0) + value;
    }
  }
}

function instrumentAnthropicMessageStream(
  stream: AnthropicMessageStream & Record<string, unknown>,
  state: AnthropicToolRunnerState,
): void {
  if ("__braintrust_tool_runner_stream_patched" in stream) {
    return;
  }

  if (!Object.isFrozen(stream) && !Object.isSealed(stream)) {
    patchStreamIfNeeded<AnthropicStreamEvent>(stream, {
      onChunk: () => {
        if (state.firstTokenTime === undefined) {
          state.firstTokenTime = getCurrentUnixTimestamp();
        }
      },
      onComplete: () => undefined,
    });
  }

  if (typeof stream.finalMessage === "function") {
    const originalFinalMessage = stream.finalMessage.bind(stream);
    stream.finalMessage = async () => {
      const message = await originalFinalMessage();
      recordAnthropicToolRunnerMessage(state, message);
      return message;
    };
  }

  Object.defineProperty(stream, "__braintrust_tool_runner_stream_patched", {
    value: true,
  });
}

async function finalizeAnthropicToolRunner(
  state: AnthropicToolRunnerState,
  finalMessage?: AnthropicMessage,
): Promise<void> {
  if (state.finalized) {
    return;
  }
  state.finalized = true;

  const message = finalMessage ?? state.lastMessage;
  if (message) {
    recordAnthropicToolRunnerMessage(state, message);
  }

  const metrics = finalizeAnthropicTokens({
    ...state.aggregatedMetrics,
  });
  if (state.firstTokenTime !== undefined) {
    metrics.time_to_first_token = state.firstTokenTime - state.startTime;
  }

  const metadata: Record<string, unknown> = {
    anthropic_tool_runner_iterations: state.iterationCount,
  };
  if (message?.stop_reason !== undefined) {
    metadata.stop_reason = message.stop_reason;
  }
  if (message?.stop_sequence !== undefined) {
    metadata.stop_sequence = message.stop_sequence;
  }

  state.span.log({
    ...(message
      ? { output: { role: message.role, content: message.content } }
      : {}),
    metadata,
    metrics: Object.fromEntries(
      Object.entries(metrics).filter(
        (entry): entry is [string, number] => entry[1] !== undefined,
      ),
    ),
  });
  state.span.end();
}

function finalizeAnthropicToolRunnerError(
  state: AnthropicToolRunnerState,
  error: unknown,
): void {
  if (state.finalized) {
    return;
  }
  state.finalized = true;
  state.span.log({
    error: error instanceof Error ? error.message : String(error),
  });
  state.span.end();
}

async function resolveAnthropicToolRunnerFinalMessage(
  runner: AnthropicToolRunner<unknown>,
): Promise<AnthropicMessage | undefined> {
  if (typeof runner.done === "function") {
    return await runner.done();
  }

  if (typeof runner.runUntilDone === "function") {
    return await runner.runUntilDone();
  }

  return undefined;
}

function wrapAnthropicToolRunnerPromiseMethod(
  runnerRecord: Record<string, unknown>,
  methodName: "done" | "runUntilDone",
  state: AnthropicToolRunnerState,
): void {
  const method = runnerRecord[methodName];
  if (typeof method !== "function") {
    return;
  }

  runnerRecord[methodName] = async (...args: unknown[]) => {
    ensureAnthropicToolRunnerToolsWrapped(runnerRecord, state);
    return await withCurrent(state.span, async () => {
      try {
        const message = (await (
          method as (...args: unknown[]) => unknown
        ).apply(runnerRecord, args)) as AnthropicMessage;
        recordAnthropicToolRunnerMessage(state, message);
        await finalizeAnthropicToolRunner(state, message);
        return message;
      } catch (error) {
        finalizeAnthropicToolRunnerError(state, error);
        throw error;
      }
    });
  };
}

function patchAnthropicToolRunner(args: {
  runner: AnthropicToolRunner<unknown>;
  state: AnthropicToolRunnerState;
}): void {
  const { runner, state } = args;
  if (!runner || typeof runner !== "object") {
    void finalizeAnthropicToolRunner(state);
    return;
  }

  const runnerRecord = runner as AnthropicToolRunner<unknown> &
    Record<string, unknown>;
  if ("__braintrust_tool_runner_patched" in runnerRecord) {
    return;
  }

  ensureAnthropicToolRunnerToolsWrapped(runnerRecord, state);
  wrapAnthropicToolRunnerSetMessagesParams(runnerRecord, state);
  wrapAnthropicToolRunnerPromiseMethod(runnerRecord, "done", state);
  wrapAnthropicToolRunnerPromiseMethod(runnerRecord, "runUntilDone", state);

  if (!isAsyncIterable(runnerRecord)) {
    Object.defineProperty(runnerRecord, "__braintrust_tool_runner_patched", {
      value: true,
    });
    return;
  }

  const originalIterator =
    runnerRecord[Symbol.asyncIterator].bind(runnerRecord);
  runnerRecord[Symbol.asyncIterator] = function () {
    const iterator = originalIterator() as AsyncIterator<unknown>;

    return {
      async next(value?: unknown) {
        try {
          ensureAnthropicToolRunnerToolsWrapped(runnerRecord, state);
          const result = await withCurrent(state.span, () =>
            value === undefined
              ? iterator.next()
              : (
                  iterator.next as (
                    value: unknown,
                  ) => Promise<IteratorResult<unknown>>
                )(value),
          );

          if (result.done) {
            const finalMessage =
              await resolveAnthropicToolRunnerFinalMessage(runner);
            await finalizeAnthropicToolRunner(state, finalMessage);
            return result;
          }

          state.iterationCount += 1;
          if (isAnthropicMessage(result.value)) {
            if (state.firstTokenTime === undefined) {
              state.firstTokenTime = getCurrentUnixTimestamp();
            }
            recordAnthropicToolRunnerMessage(state, result.value);
          } else if (isAnthropicMessageStream(result.value)) {
            instrumentAnthropicMessageStream(result.value, state);
          }

          return result;
        } catch (error) {
          finalizeAnthropicToolRunnerError(state, error);
          throw error;
        }
      },

      async return(value?: unknown) {
        try {
          ensureAnthropicToolRunnerToolsWrapped(runnerRecord, state);
          const result =
            typeof iterator.return === "function"
              ? await withCurrent(state.span, () => iterator.return!(value))
              : ({ done: true, value } as IteratorResult<unknown>);
          const finalMessage = await resolveAnthropicToolRunnerFinalMessage(
            runner,
          ).catch(() => undefined);
          await finalizeAnthropicToolRunner(state, finalMessage);
          return result;
        } catch (error) {
          finalizeAnthropicToolRunnerError(state, error);
          throw error;
        }
      },

      async throw(error?: unknown) {
        finalizeAnthropicToolRunnerError(state, error);
        if (typeof iterator.throw === "function") {
          return await withCurrent(state.span, () => iterator.throw!(error));
        }
        throw error;
      },

      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };

  Object.defineProperty(runnerRecord, "__braintrust_tool_runner_patched", {
    value: true,
  });
}

/**
 * Aggregate Anthropic stream chunks into a single response.
 *
 * Anthropic stream format:
 * - message_start: Contains initial message with usage stats
 * - content_block_start: Start of a content block (text, image, etc.)
 * - content_block_delta: Text deltas to concatenate
 * - message_delta: Final usage stats and metadata
 * - message_stop: End of stream
 */
type ContentBlockAccumulator = {
  textDeltas: string[];
  citations: AnthropicCitation[];
};

type ToolUseLikeContentBlock = {
  type: "tool_use" | "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export function aggregateAnthropicStreamChunks(
  chunks: AnthropicStreamEvent[],
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
} {
  const fallbackTextDeltas: string[] = [];
  const contentBlocks: Record<number, AnthropicOutputContentBlock> = {};
  const contentBlockDeltas: Record<number, ContentBlockAccumulator> = {};
  let metrics: Record<string, number> = {};
  let metadata: Record<string, unknown> = {};
  let role: string | undefined;

  for (const event of chunks) {
    switch (event?.type) {
      case "message_start":
        // Collect initial metrics from message
        if (event.message?.usage) {
          const initialMetrics = parseMetricsFromUsage(event.message.usage);
          metrics = { ...metrics, ...initialMetrics };
        }
        if (typeof event.message?.role === "string") {
          role = event.message.role;
        }
        break;

      case "content_block_start":
        if (event.content_block) {
          contentBlocks[event.index] = event.content_block;
          contentBlockDeltas[event.index] = { textDeltas: [], citations: [] };
        }
        break;

      case "content_block_delta": {
        const acc = contentBlockDeltas[event.index];
        const delta = event.delta;
        if (!delta) break;
        if (delta.type === "text_delta" && "text" in delta) {
          const text = (delta as { type: string; text: string }).text;
          if (text) {
            if (acc !== undefined) {
              acc.textDeltas.push(text);
            } else {
              fallbackTextDeltas.push(text);
            }
          }
        } else if (
          delta.type === "input_json_delta" &&
          "partial_json" in delta
        ) {
          const partialJson = (delta as { type: string; partial_json: string })
            .partial_json;
          if (partialJson && acc !== undefined) {
            acc.textDeltas.push(partialJson);
          }
        } else if (delta.type === "thinking_delta" && "thinking" in delta) {
          const thinking = (delta as { type: string; thinking: string })
            .thinking;
          if (thinking && acc !== undefined) {
            acc.textDeltas.push(thinking);
          }
        } else if (delta.type === "citations_delta" && "citation" in delta) {
          const citation = (
            delta as { type: string; citation: AnthropicCitation }
          ).citation;
          if (citation && acc !== undefined) {
            acc.citations.push(citation);
          }
        }
        // signature_delta and unknown future delta types: ignored
        break;
      }

      case "content_block_stop":
        finalizeContentBlock(
          event.index,
          contentBlocks,
          contentBlockDeltas,
          fallbackTextDeltas,
        );
        break;

      case "message_delta":
        // Collect final usage stats and metadata
        if (event.usage) {
          const finalMetrics = parseMetricsFromUsage(event.usage);
          metrics = { ...metrics, ...finalMetrics };
        }
        if (event.delta) {
          // stop_reason, stop_sequence, etc.
          metadata = { ...metadata, ...event.delta };
        }
        break;
    }
  }

  const orderedContent = Object.entries(contentBlocks)
    .map(([index, block]) => ({
      block,
      index: Number(index),
    }))
    .filter(({ block }) => block !== undefined)
    .sort((left, right) => left.index - right.index)
    .map(({ block }) => block);

  let output: unknown = fallbackTextDeltas.join("");
  if (orderedContent.length > 0) {
    if (
      orderedContent.every(isTextContentBlock) &&
      orderedContent.every((block) => !block.citations?.length)
    ) {
      output = orderedContent.map((block) => block.text).join("");
    } else {
      output = {
        ...(role ? { role } : {}),
        content: orderedContent,
      };
    }
  }

  const finalized = finalizeAnthropicTokens(metrics);
  // Filter out undefined values to match Record<string, number> type
  const filteredMetrics = Object.fromEntries(
    Object.entries(finalized).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );

  return {
    output,
    metrics: filteredMetrics,
    metadata,
  };
}

function finalizeContentBlock(
  index: number,
  contentBlocks: Record<number, AnthropicOutputContentBlock>,
  contentBlockDeltas: Record<number, ContentBlockAccumulator>,
  fallbackTextDeltas: string[],
): void {
  const contentBlock = contentBlocks[index];
  if (!contentBlock) {
    return;
  }

  const acc = contentBlockDeltas[index];
  const text = acc?.textDeltas.join("") ?? "";

  if (isToolUseLikeContentBlock(contentBlock)) {
    if (!text) {
      return;
    }

    try {
      const parsedInput = JSON.parse(text) as unknown;
      if (!isObject(parsedInput)) {
        fallbackTextDeltas.push(text);
        delete contentBlocks[index];
        return;
      }

      const parsedToolUseBlock: ToolUseLikeContentBlock = {
        type: contentBlock.type,
        id: contentBlock.id,
        name: contentBlock.name,
        input: parsedInput,
      };
      contentBlocks[index] = parsedToolUseBlock;
    } catch {
      fallbackTextDeltas.push(text);
      delete contentBlocks[index];
    }
    return;
  }

  if (isTextContentBlock(contentBlock)) {
    if (!text) {
      delete contentBlocks[index];
      return;
    }

    const updated: AnthropicOutputContentBlock = { ...contentBlock, text };
    if (acc?.citations.length) {
      (
        updated as {
          type: "text";
          text: string;
          citations?: AnthropicCitation[];
        }
      ).citations = acc.citations;
    }
    contentBlocks[index] = updated;
    return;
  }

  if (isThinkingContentBlock(contentBlock)) {
    if (!text) {
      delete contentBlocks[index];
      return;
    }

    contentBlocks[index] = {
      ...contentBlock,
      thinking: text,
    };
    return;
  }

  // Forward-compatible default: preserve unrecognized blocks as-is rather than deleting.
  // This ensures future Anthropic content block types (server_tool_use, web_search_tool_result, etc.)
  // are not silently dropped from traces.
}

function isTextContentBlock(
  contentBlock: AnthropicOutputContentBlock,
): contentBlock is Extract<AnthropicOutputContentBlock, { type: "text" }> {
  return contentBlock.type === "text";
}

function isToolUseLikeContentBlock(
  contentBlock: AnthropicOutputContentBlock,
): contentBlock is ToolUseLikeContentBlock {
  return (
    (contentBlock.type === "tool_use" ||
      contentBlock.type === "server_tool_use") &&
    typeof (contentBlock as { id?: unknown }).id === "string" &&
    typeof (contentBlock as { name?: unknown }).name === "string" &&
    isObject((contentBlock as { input?: unknown }).input)
  );
}

function isThinkingContentBlock(
  contentBlock: AnthropicOutputContentBlock,
): contentBlock is Extract<AnthropicOutputContentBlock, { type: "thinking" }> {
  return contentBlock.type === "thinking";
}

function isAnthropicBase64ContentBlock(
  input: Record<string, unknown>,
): input is Record<string, unknown> & {
  source: AnthropicBase64Source;
  type: "image" | "document";
} {
  return (
    (input.type === "image" || input.type === "document") &&
    isObject(input.source) &&
    input.source.type === "base64"
  );
}

/**
 * Helper function to convert base64 content to an Attachment.
 */
function convertBase64ToAttachment(
  source: AnthropicBase64Source,
  contentType: "image" | "document",
): Record<string, unknown> {
  const mediaType =
    typeof source.media_type === "string" ? source.media_type : "image/png";
  const base64Data = source.data;

  if (base64Data && typeof base64Data === "string") {
    // Convert base64 string to Blob
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mediaType });

    // Determine file extension from media type
    const extension = mediaType.split("/")[1] || "bin";
    // Use a descriptive prefix based on content type
    const prefix = contentType === "document" ? "document" : "image";
    const filename = `${prefix}.${extension}`;

    const attachment = new Attachment({
      data: blob,
      filename: filename,
      contentType: mediaType,
    });

    return {
      ...source,
      data: attachment,
    };
  }

  return { ...source };
}

/**
 * Process input to convert base64 attachments (images, PDFs, etc.) to Attachment objects.
 */
export function processAttachmentsInInput(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(processAttachmentsInInput);
  }

  if (isObject(input)) {
    // Check for Anthropic's content blocks with base64 data
    // Supports both "image" and "document" types (for PDFs, etc.)
    if (isAnthropicBase64ContentBlock(input)) {
      return {
        ...input,
        source: convertBase64ToAttachment(input.source, input.type),
      };
    }

    // Recursively process nested objects
    const processed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      processed[key] = processAttachmentsInInput(value);
    }
    return processed;
  }

  return input;
}

/**
 * Convert Anthropic args to the single "input" field Braintrust expects.
 * Combines messages array with system message if present.
 */
function coalesceInput(
  messages: AnthropicInputMessage[],
  system: AnthropicCreateParams["system"],
): AnthropicInputMessage[] {
  // Make a copy because we're going to mutate it
  const input = (messages || []).slice();
  if (system) {
    input.push({ role: "system", content: system });
  }
  return input;
}
