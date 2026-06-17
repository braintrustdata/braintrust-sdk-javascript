import { BasePlugin } from "../core";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import type {
  ChannelMessage,
  ErrorOf,
  StartOf,
} from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import {
  _internalGetGlobalState,
  Attachment,
  BRAINTRUST_CURRENT_SPAN_STORE,
  startSpan,
  type CurrentSpanStore,
  type StartSpanArgs,
  type Span,
} from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { googleGenAIChannels } from "./google-genai-channels";
import type {
  GoogleGenAIEmbedContentParams,
  GoogleGenAIEmbedContentResponse,
  GoogleGenAIGenerateContentParams,
  GoogleGenAIGenerateContentResponse,
  GoogleGenAIContent,
  GoogleGenAIInteraction,
  GoogleGenAIInteractionCreateParams,
  GoogleGenAIInteractionSSEEvent,
  GoogleGenAIInteractionUsage,
  GoogleGenAIPart,
  GoogleGenAIUsageMetadata,
} from "../../vendor-sdk-types/google-genai";

type GenerateContentChannel = typeof googleGenAIChannels.generateContent;
type GenerateContentStreamChannel =
  typeof googleGenAIChannels.generateContentStream;
type EmbedContentChannel = typeof googleGenAIChannels.embedContent;
type InteractionsCreateChannel = typeof googleGenAIChannels.interactionsCreate;
type GoogleGenAINonStreamingChannel =
  | GenerateContentChannel
  | EmbedContentChannel;
type GenerateContentStreamEvent =
  ChannelMessage<GenerateContentStreamChannel> & {
    googleGenAIInput?: Record<string, unknown>;
    googleGenAIMetadata?: Record<string, unknown>;
    googleGenAIStartTime?: number;
  };

type SpanState = {
  span: Span;
  startTime: number;
};

const GOOGLE_GENAI_INTERNAL_CONTEXT = {
  caller_filename: "<node-internal>",
  caller_functionname: "<node-internal>",
  caller_lineno: 0,
};

function createWrapperParityEvent(args: {
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): StartSpanArgs["event"] {
  return {
    context: GOOGLE_GENAI_INTERNAL_CONTEXT,
    input: args.input,
    metadata: args.metadata,
  } as StartSpanArgs["event"];
}

/**
 * Auto-instrumentation plugin for the Google GenAI SDK.
 *
 * This plugin subscribes to orchestrion channels for Google GenAI SDK methods
 * and creates Braintrust spans to track:
 * - models.generateContent (non-streaming)
 * - models.generateContentStream (streaming)
 * - models.embedContent (embeddings)
 *
 * The plugin handles:
 * - Google-specific token metrics (promptTokenCount, candidatesTokenCount, cachedContentTokenCount)
 * - Processing streaming responses
 * - Converting inline data (images) to Attachment objects
 * - Tool calls (functionCall, functionResponse) and executable code results
 */
export class GoogleGenAIPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToGoogleGenAIChannels();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToGoogleGenAIChannels(): void {
    this.subscribeToGenerateContentChannel();
    this.subscribeToGenerateContentStreamChannel();
    this.subscribeToEmbedContentChannel();
    this.subscribeToInteractionsCreateChannel();
  }

  private subscribeToGenerateContentChannel(): void {
    const tracingChannel =
      googleGenAIChannels.generateContent.tracingChannel() as IsoTracingChannel<
        ChannelMessage<GenerateContentChannel>
      >;
    const states = new WeakMap<object, SpanState>();
    const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
      tracingChannel,
      states,
      (event) => {
        const params = event.arguments[0];
        const input = serializeGenerateContentInput(params);
        const metadata = extractGenerateContentMetadata(params);
        const span = startSpan({
          name: "generate_content",
          spanAttributes: {
            type: SpanTypeAttribute.LLM,
          },
          event: createWrapperParityEvent({ input, metadata }),
        });

        return {
          span,
          startTime: getCurrentUnixTimestamp(),
        };
      },
    );

    const handlers: IsoChannelHandlers<ChannelMessage<GenerateContentChannel>> =
      {
        start: (event) => {
          ensureSpanState(states, event, () => {
            const params = event.arguments[0];
            const input = serializeGenerateContentInput(params);
            const metadata = extractGenerateContentMetadata(params);
            const span = startSpan({
              name: "generate_content",
              spanAttributes: {
                type: SpanTypeAttribute.LLM,
              },
              event: createWrapperParityEvent({ input, metadata }),
            });

            return {
              span,
              startTime: getCurrentUnixTimestamp(),
            };
          });
        },
        asyncEnd: (event) => {
          const spanState = states.get(event as object);
          if (!spanState) {
            return;
          }

          try {
            const responseMetadata = extractResponseMetadata(event.result);
            spanState.span.log({
              ...(responseMetadata ? { metadata: responseMetadata } : {}),
              metrics: cleanMetrics(
                extractGenerateContentMetrics(
                  event.result,
                  spanState.startTime,
                ),
              ),
              output: event.result,
            });
          } finally {
            spanState.span.end();
            states.delete(event as object);
          }
        },
        error: (event) => {
          logErrorAndEndSpan(states, event as ErrorOf<GenerateContentChannel>);
        },
      };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToGenerateContentStreamChannel(): void {
    const tracingChannel =
      googleGenAIChannels.generateContentStream.tracingChannel() as IsoTracingChannel<
        ChannelMessage<GenerateContentStreamChannel>
      >;

    const handlers: IsoChannelHandlers<
      ChannelMessage<GenerateContentStreamChannel>
    > = {
      start: (event) => {
        const streamEvent = event as GenerateContentStreamEvent;
        const params = event.arguments[0];
        streamEvent.googleGenAIInput = serializeGenerateContentInput(params);
        streamEvent.googleGenAIMetadata =
          extractGenerateContentMetadata(params);
        streamEvent.googleGenAIStartTime = getCurrentUnixTimestamp();
      },
      asyncEnd: (event) => {
        const streamEvent = event as GenerateContentStreamEvent;
        patchGoogleGenAIStreamingResult({
          input: streamEvent.googleGenAIInput,
          metadata: streamEvent.googleGenAIMetadata,
          startTime: streamEvent.googleGenAIStartTime,
          result: streamEvent.result,
        });
      },
      error: () => {},
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToEmbedContentChannel(): void {
    const tracingChannel =
      googleGenAIChannels.embedContent.tracingChannel() as IsoTracingChannel<
        ChannelMessage<EmbedContentChannel>
      >;
    const states = new WeakMap<object, SpanState>();
    const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
      tracingChannel,
      states,
      (event) => {
        const params = event.arguments[0];
        const input = serializeEmbedContentInput(params);
        const metadata = extractEmbedContentMetadata(params);
        const span = startSpan({
          name: "embed_content",
          spanAttributes: {
            type: SpanTypeAttribute.LLM,
          },
          event: createWrapperParityEvent({ input, metadata }),
        });

        return {
          span,
          startTime: getCurrentUnixTimestamp(),
        };
      },
    );

    const handlers: IsoChannelHandlers<ChannelMessage<EmbedContentChannel>> = {
      start: (event) => {
        ensureSpanState(states, event, () => {
          const params = event.arguments[0];
          const input = serializeEmbedContentInput(params);
          const metadata = extractEmbedContentMetadata(params);
          const span = startSpan({
            name: "embed_content",
            spanAttributes: {
              type: SpanTypeAttribute.LLM,
            },
            event: createWrapperParityEvent({ input, metadata }),
          });

          return {
            span,
            startTime: getCurrentUnixTimestamp(),
          };
        });
      },
      asyncEnd: (event) => {
        const spanState = states.get(event as object);
        if (!spanState) {
          return;
        }

        try {
          const output = summarizeEmbedContentOutput(event.result);
          spanState.span.log({
            ...(output ? { output } : {}),
            metrics: cleanMetrics(
              extractEmbedContentMetrics(event.result, spanState.startTime),
            ),
          });
        } finally {
          spanState.span.end();
          states.delete(event as object);
        }
      },
      error: (event) => {
        logErrorAndEndSpan(states, event as ErrorOf<EmbedContentChannel>);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToInteractionsCreateChannel(): void {
    this.unsubscribers.push(
      traceStreamingChannel(
        googleGenAIChannels.interactionsCreate as InteractionsCreateChannel,
        {
          name: "create_interaction",
          shouldTrace: ([params]) => !isBackgroundInteractionCreate(params),
          type: SpanTypeAttribute.LLM,
          extractInput: ([params]) => ({
            input: serializeInteractionInput(params),
            metadata: extractInteractionMetadata(params),
          }),
          extractOutput: (result) => serializeInteractionValue(result),
          extractMetadata: (result) =>
            extractInteractionResponseMetadata(result),
          extractMetrics: (result, startTime) =>
            cleanMetrics(extractInteractionMetrics(result, startTime)),
          aggregateChunks: (chunks, _result, _event, startTime) =>
            aggregateInteractionEvents(chunks, startTime),
        },
      ),
    );
  }
}

function isBackgroundInteractionCreate(params: unknown): boolean {
  return tryToDict(params)?.background === true;
}

function ensureSpanState<TEvent extends object>(
  states: WeakMap<object, SpanState>,
  event: TEvent,
  create: () => SpanState,
): SpanState {
  const existing = states.get(event);
  if (existing) {
    return existing;
  }

  const created = create();
  states.set(event, created);
  return created;
}

function bindCurrentSpanStoreToStart<
  TChannel extends GoogleGenAINonStreamingChannel,
>(
  tracingChannel: IsoTracingChannel<ChannelMessage<TChannel>>,
  states: WeakMap<object, SpanState>,
  create: (event: StartOf<TChannel>) => SpanState,
): (() => void) | undefined {
  const state = _internalGetGlobalState();
  const contextManager = state?.contextManager;
  const startChannel = tracingChannel.start as
    | ({
        bindStore?: (
          store: CurrentSpanStore,
          callback: (event: ChannelMessage<TChannel>) => unknown,
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
    const span = ensureSpanState(states, event as object, () =>
      create(event as StartOf<TChannel>),
    ).span;
    return contextManager!.wrapSpanForStore(span);
  });

  return () => {
    startChannel.unbindStore?.(currentSpanStore);
  };
}

function logErrorAndEndSpan<TChannel extends GoogleGenAINonStreamingChannel>(
  states: WeakMap<object, SpanState>,
  event: ErrorOf<TChannel>,
): void {
  const spanState = states.get(event as object);
  if (!spanState) {
    return;
  }

  spanState.span.log({
    error: event.error.message,
  });
  spanState.span.end();
  states.delete(event as object);
}

function patchGoogleGenAIStreamingResult(args: {
  input: Record<string, unknown> | undefined;
  metadata: Record<string, unknown> | undefined;
  startTime: number | undefined;
  result: unknown;
}): boolean {
  const { input, metadata, result, startTime } = args;

  if (
    !input ||
    !metadata ||
    !result ||
    typeof result !== "object" ||
    typeof (result as AsyncIterator<GoogleGenAIGenerateContentResponse>)
      .next !== "function"
  ) {
    return false;
  }

  const chunks: GoogleGenAIGenerateContentResponse[] = [];
  let firstTokenTime: number | null = null;
  let finalized = false;
  let span: Span | null = null;
  const requestStartTime = startTime ?? getCurrentUnixTimestamp();

  const ensureSpan = () => {
    if (!span) {
      span = startSpan({
        name: "generate_content_stream",
        spanAttributes: {
          type: SpanTypeAttribute.LLM,
        },
        event: {
          input,
          metadata,
        },
      });
    }

    return span;
  };

  const finalize = (options: {
    error?: unknown;
    result?: {
      aggregated: Record<string, unknown>;
      metrics: Record<string, number>;
    };
  }) => {
    if (finalized || !span) {
      return;
    }

    finalized = true;

    if (options.result) {
      const { end, ...metricsWithoutEnd } = options.result.metrics;
      const responseMetadata = extractResponseMetadata(
        options.result.aggregated,
      );
      span.log({
        ...(responseMetadata ? { metadata: responseMetadata } : {}),
        metrics: cleanMetrics(metricsWithoutEnd),
        output: options.result.aggregated,
      });
      span.end(typeof end === "number" ? { endTime: end } : undefined);
      return;
    }

    if (options.error !== undefined) {
      span.log({
        error:
          options.error instanceof Error
            ? options.error.message
            : String(options.error),
      });
    }

    span.end();
  };

  const patchIterator = (
    iterator: AsyncIterator<GoogleGenAIGenerateContentResponse>,
  ): AsyncIterator<GoogleGenAIGenerateContentResponse> => {
    if (
      typeof iterator !== "object" ||
      iterator === null ||
      "__braintrustGoogleGenAIPatched" in (iterator as object)
    ) {
      return iterator;
    }

    const iteratorRecord =
      iterator as AsyncIterator<GoogleGenAIGenerateContentResponse> &
        Record<string | symbol, unknown>;
    const originalNext =
      typeof iteratorRecord.next === "function"
        ? (
            iteratorRecord.next as (
              ...args: [] | [undefined]
            ) => Promise<IteratorResult<GoogleGenAIGenerateContentResponse>>
          ).bind(iterator)
        : undefined;
    const originalReturn =
      typeof iteratorRecord.return === "function"
        ? (
            iteratorRecord.return as (
              ...args: [] | [unknown]
            ) => Promise<IteratorResult<GoogleGenAIGenerateContentResponse>>
          ).bind(iterator)
        : undefined;
    const originalThrow =
      typeof iteratorRecord.throw === "function"
        ? (
            iteratorRecord.throw as (
              ...args: [] | [unknown]
            ) => Promise<IteratorResult<GoogleGenAIGenerateContentResponse>>
          ).bind(iterator)
        : undefined;
    const asyncIteratorMethod = iteratorRecord[Symbol.asyncIterator];
    const originalAsyncIterator =
      typeof asyncIteratorMethod === "function"
        ? (
            asyncIteratorMethod as () => AsyncIterator<GoogleGenAIGenerateContentResponse>
          ).bind(iterator)
        : undefined;

    Object.defineProperty(iteratorRecord, "__braintrustGoogleGenAIPatched", {
      configurable: true,
      enumerable: false,
      value: true,
      writable: false,
    });

    if (originalNext) {
      iteratorRecord.next = async (...nextArgs: [] | [undefined]) => {
        ensureSpan();

        try {
          const nextResult = (await originalNext(
            ...nextArgs,
          )) as IteratorResult<GoogleGenAIGenerateContentResponse>;

          if (!nextResult.done && nextResult.value) {
            if (firstTokenTime === null) {
              firstTokenTime = getCurrentUnixTimestamp();
            }
            chunks.push(nextResult.value);
          }

          if (nextResult.done) {
            finalize({
              result: aggregateGenerateContentChunks(
                chunks,
                requestStartTime,
                firstTokenTime,
              ),
            });
          }

          return nextResult;
        } catch (error) {
          finalize({ error });
          throw error;
        }
      };
    }

    if (originalReturn) {
      iteratorRecord.return = async (...returnArgs: [] | [unknown]) => {
        ensureSpan();

        try {
          return (await originalReturn(
            ...returnArgs,
          )) as IteratorResult<GoogleGenAIGenerateContentResponse>;
        } finally {
          if (chunks.length > 0) {
            finalize({
              result: aggregateGenerateContentChunks(
                chunks,
                requestStartTime,
                firstTokenTime,
              ),
            });
          } else {
            finalize({});
          }
        }
      };
    }

    if (originalThrow) {
      iteratorRecord.throw = async (...throwArgs: [] | [unknown]) => {
        ensureSpan();

        try {
          return (await originalThrow(
            ...throwArgs,
          )) as IteratorResult<GoogleGenAIGenerateContentResponse>;
        } catch (error) {
          finalize({ error });
          throw error;
        }
      };
    }

    iteratorRecord[Symbol.asyncIterator] = () => {
      const asyncIterator = originalAsyncIterator
        ? (originalAsyncIterator() as AsyncIterator<GoogleGenAIGenerateContentResponse>)
        : iterator;
      return patchIterator(asyncIterator);
    };

    return iterator;
  };

  patchIterator(result as AsyncIterator<GoogleGenAIGenerateContentResponse>);
  return true;
}

function serializeGenerateContentInput(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    model: params.model,
    contents: serializeContentCollection(params.contents),
  };

  const config = params.config ? tryToDict(params.config) : null;
  if (config) {
    const filteredConfig: Record<string, unknown> = {};
    Object.keys(config).forEach((key) => {
      if (key !== "tools") {
        filteredConfig[key] = config[key];
      }
    });
    input.config = filteredConfig;
  }

  return input;
}

function serializeEmbedContentInput(
  params: GoogleGenAIEmbedContentParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    model: params.model,
    contents: serializeContentCollection(params.contents),
  };

  const config = params.config ? tryToDict(params.config) : null;
  if (config) {
    input.config = config;
  }

  return input;
}

function serializeInteractionInput(
  params: GoogleGenAIInteractionCreateParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    input: serializeInteractionValue(params.input),
  };

  for (const key of [
    "model",
    "agent",
    "agent_config",
    "api_version",
    "background",
    "environment",
    "generation_config",
    "previous_interaction_id",
    "response_format",
    "response_mime_type",
    "response_modalities",
    "service_tier",
    "store",
    "stream",
    "system_instruction",
    "webhook_config",
  ]) {
    const value = params[key];
    if (value !== undefined) {
      input[key] = serializeInteractionValue(value);
    }
  }

  return input;
}

function extractInteractionMetadata(
  params: GoogleGenAIInteractionCreateParams,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  for (const key of [
    "model",
    "agent",
    "agent_config",
    "generation_config",
    "system_instruction",
    "response_format",
    "response_mime_type",
    "response_modalities",
    "service_tier",
  ]) {
    const value = params[key];
    if (value !== undefined) {
      metadata[key] = serializeInteractionValue(value);
    }
  }

  if (Array.isArray(params.tools)) {
    metadata.tools = params.tools.map((tool) =>
      serializeInteractionValue(tool),
    );
  }

  return metadata;
}

/**
 * Serialize contents, converting inline data to Attachments.
 */
function serializeContentCollection(
  contents: string | GoogleGenAIContent | GoogleGenAIContent[],
): unknown {
  if (contents === null || contents === undefined) {
    return null;
  }

  if (Array.isArray(contents)) {
    return contents.map((item) => serializeContentItem(item));
  }

  return serializeContentItem(contents);
}

/**
 * Serialize a single content item.
 */
function serializeContentItem(item: string | GoogleGenAIContent): unknown {
  if (typeof item === "object" && item !== null) {
    if (item.parts && Array.isArray(item.parts)) {
      return {
        ...item,
        parts: item.parts.map((part: GoogleGenAIPart) => serializePart(part)),
      };
    }
    return item;
  }

  if (typeof item === "string") {
    return { text: item };
  }

  return item;
}

/**
 * Serialize a part, converting inline data to Attachments.
 */
function serializePart(part: GoogleGenAIPart): unknown {
  if (!part || typeof part !== "object") {
    return part;
  }

  if (part.inlineData && part.inlineData.data) {
    const { data, mimeType } = part.inlineData;
    const attachment = createAttachmentFromInlineData(data, mimeType);

    if (attachment) {
      return {
        image_url: { url: attachment },
      };
    }
  }

  return part;
}

function serializeInteractionValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeInteractionValue(item, seen));
  }

  const dict: unknown = tryToDict(value);
  if (dict === null || dict === undefined || typeof dict !== "object") {
    return dict;
  }

  if (Array.isArray(dict)) {
    return dict.map((item) => serializeInteractionValue(item, seen));
  }

  if (seen.has(dict)) {
    return "[Circular]";
  }

  seen.add(dict);
  try {
    const serialized: Record<string, unknown> = {};
    const mimeType =
      "mime_type" in dict && typeof dict.mime_type === "string"
        ? dict.mime_type
        : "mimeType" in dict && typeof dict.mimeType === "string"
          ? dict.mimeType
          : undefined;
    const attachment =
      mimeType && "data" in dict && dict.data !== undefined
        ? createAttachmentFromInlineData(dict.data, mimeType)
        : null;

    for (const [key, entry] of Object.entries(dict)) {
      if (key === "data" && attachment) {
        serialized[key] = attachment;
      } else {
        serialized[key] = serializeInteractionValue(entry, seen);
      }
    }

    return serialized;
  } finally {
    seen.delete(dict);
  }
}

function createAttachmentFromInlineData(
  data: unknown,
  mimeType?: string,
): Attachment | null {
  if (
    !(
      data instanceof Uint8Array ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) ||
      typeof data === "string"
    )
  ) {
    return null;
  }

  const extension = mimeType ? mimeType.split("/")[1] : "bin";
  const filename = `file.${extension}`;
  const buffer =
    typeof data === "string"
      ? typeof Buffer !== "undefined"
        ? Buffer.from(data, "base64")
        : new Uint8Array(
            atob(data)
              .split("")
              .map((c) => c.charCodeAt(0)),
          )
      : typeof Buffer !== "undefined"
        ? Buffer.from(data)
        : new Uint8Array(data);
  const arrayBuffer =
    buffer instanceof Uint8Array
      ? buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        )
      : buffer;

  return new Attachment({
    data: arrayBuffer,
    filename,
    contentType: mimeType || "application/octet-stream",
  });
}

function serializeGenerateContentTools(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown>[] | null {
  const config = params.config ? tryToDict(params.config) : null;
  const tools = config?.tools;
  if (!Array.isArray(tools)) {
    return null;
  }

  try {
    const serializedTools: Record<string, unknown>[] = [];
    for (const tool of tools) {
      const toolDict = tryToDict(tool);
      if (toolDict) {
        serializedTools.push(toolDict);
      }
    }
    return serializedTools.length > 0 ? serializedTools : null;
  } catch {
    return null;
  }
}

function extractGenerateContentMetadata(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (params.model) {
    metadata.model = params.model;
  }

  if (params.config) {
    const config = tryToDict(params.config);
    if (config) {
      Object.keys(config).forEach((key) => {
        if (key !== "tools") {
          metadata[key] = config[key];
        }
      });
    }
  }

  const tools = serializeGenerateContentTools(params);
  if (tools) {
    metadata.tools = tools;
  }

  return metadata;
}

function extractEmbedContentMetadata(
  params: GoogleGenAIEmbedContentParams,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (params.model) {
    metadata.model = params.model;
  }

  const config = params.config ? tryToDict(params.config) : null;
  if (config) {
    Object.keys(config).forEach((key) => {
      metadata[key] = config[key];
    });
  }

  return metadata;
}

/**
 * Extract metrics from non-streaming generateContent response.
 */
function extractGenerateContentMetrics(
  response: GoogleGenAIGenerateContentResponse | undefined,
  startTime?: number,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (startTime !== undefined) {
    const end = getCurrentUnixTimestamp();
    metrics.start = startTime;
    metrics.end = end;
    metrics.duration = end - startTime;
  }

  if (response?.usageMetadata) {
    populateUsageMetrics(metrics, response.usageMetadata);
  }

  return metrics;
}

function extractEmbedContentMetrics(
  response: GoogleGenAIEmbedContentResponse | undefined,
  startTime?: number,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (startTime !== undefined) {
    const end = getCurrentUnixTimestamp();
    metrics.start = startTime;
    metrics.end = end;
    metrics.duration = end - startTime;
  }

  if (response?.usageMetadata) {
    populateUsageMetrics(metrics, response.usageMetadata);
  }

  const embeddingTokenCount = extractEmbedPromptTokenCount(response);
  if (embeddingTokenCount !== undefined) {
    metrics.prompt_tokens = embeddingTokenCount;
    metrics.tokens = embeddingTokenCount;
  }

  return metrics;
}

function extractInteractionMetrics(
  response: GoogleGenAIInteraction | undefined,
  startTime?: number,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (startTime !== undefined) {
    const end = getCurrentUnixTimestamp();
    metrics.start = startTime;
    metrics.end = end;
    metrics.duration = end - startTime;
  }

  if (response?.usage) {
    populateInteractionUsageMetrics(metrics, response.usage);
  }

  return metrics;
}

function extractInteractionResponseMetadata(
  response: GoogleGenAIInteraction | undefined,
): Record<string, unknown> | undefined {
  const responseDict = tryToDict(response);
  if (!responseDict) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  if (typeof responseDict.id === "string") {
    metadata.interaction_id = responseDict.id;
  }
  if (typeof responseDict.status === "string") {
    metadata.status = responseDict.status;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractEmbedPromptTokenCount(
  response: GoogleGenAIEmbedContentResponse | undefined,
): number | undefined {
  if (!response) {
    return undefined;
  }

  // Embedding token counts are available only on Vertex responses via usageMetadata
  // and/or embedding.statistics.tokenCount; Gemini Developer API embed responses omit them.
  const usagePromptTokens = response.usageMetadata?.promptTokenCount;
  if (
    typeof usagePromptTokens === "number" &&
    Number.isFinite(usagePromptTokens)
  ) {
    return usagePromptTokens;
  }

  const usageTotalTokens = response.usageMetadata?.totalTokenCount;
  if (
    typeof usageTotalTokens === "number" &&
    Number.isFinite(usageTotalTokens)
  ) {
    return usageTotalTokens;
  }

  const embeddings = Array.isArray(response.embeddings)
    ? response.embeddings
    : response.embedding
      ? [response.embedding]
      : [];
  if (embeddings.length === 0) {
    return undefined;
  }

  let total = 0;
  let sawAny = false;
  for (const embedding of embeddings) {
    const embeddingStats = tryToDict(tryToDict(embedding)?.statistics);
    const tokenCount = embeddingStats?.tokenCount;
    if (typeof tokenCount === "number" && Number.isFinite(tokenCount)) {
      total += tokenCount;
      sawAny = true;
    }
  }

  return sawAny ? total : undefined;
}

function summarizeEmbedContentOutput(
  response: GoogleGenAIEmbedContentResponse | undefined,
): Record<string, number> | undefined {
  if (!response) {
    return undefined;
  }

  const embeddings = Array.isArray(response.embeddings)
    ? response.embeddings
    : response.embedding
      ? [response.embedding]
      : [];
  if (embeddings.length === 0) {
    return undefined;
  }

  const firstValues = embeddings[0]?.values;
  if (!Array.isArray(firstValues)) {
    return undefined;
  }

  return {
    embedding_count: embeddings.length,
    embedding_length: firstValues.length,
  };
}

function populateUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleGenAIUsageMetadata,
): void {
  if (usage.promptTokenCount !== undefined) {
    metrics.prompt_tokens = usage.promptTokenCount;
  }
  if (usage.candidatesTokenCount !== undefined) {
    metrics.completion_tokens = usage.candidatesTokenCount;
  }
  if (usage.totalTokenCount !== undefined) {
    metrics.tokens = usage.totalTokenCount;
  }
  if (usage.cachedContentTokenCount !== undefined) {
    metrics.prompt_cached_tokens = usage.cachedContentTokenCount;
  }
  if (usage.thoughtsTokenCount !== undefined) {
    metrics.completion_reasoning_tokens = usage.thoughtsTokenCount;
  }
}

function populateInteractionUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleGenAIInteractionUsage,
): void {
  if (typeof usage.total_input_tokens === "number") {
    metrics.prompt_tokens = usage.total_input_tokens;
  }
  if (typeof usage.total_output_tokens === "number") {
    metrics.completion_tokens = usage.total_output_tokens;
  }
  if (typeof usage.total_tokens === "number") {
    metrics.tokens = usage.total_tokens;
  }
  if (typeof usage.total_cached_tokens === "number") {
    metrics.prompt_cached_tokens = usage.total_cached_tokens;
  }
  if (typeof usage.total_thought_tokens === "number") {
    metrics.completion_reasoning_tokens = usage.total_thought_tokens;
  }
}

/**
 * Aggregate chunks from streaming generateContentStream response.
 */
function aggregateGenerateContentChunks(
  chunks: GoogleGenAIGenerateContentResponse[],
  startTime: number,
  firstTokenTime: number | null,
): {
  aggregated: Record<string, unknown>;
  metrics: Record<string, number>;
} {
  const end = getCurrentUnixTimestamp();
  const metrics: Record<string, number> = {
    start: startTime,
    end,
    duration: end - startTime,
  };

  if (firstTokenTime !== null) {
    metrics.time_to_first_token = firstTokenTime - startTime;
  }

  if (chunks.length === 0) {
    return { aggregated: {}, metrics };
  }

  let text = "";
  let thoughtText = "";
  const otherParts: Record<string, unknown>[] = [];
  let groundingMetadata: unknown = undefined;
  let usageMetadata: GoogleGenAIUsageMetadata | null = null;
  let lastResponse: GoogleGenAIGenerateContentResponse | null = null;

  for (const chunk of chunks) {
    lastResponse = chunk;

    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata;
    }
    if (chunk.groundingMetadata !== undefined) {
      groundingMetadata = chunk.groundingMetadata;
    }

    if (chunk.candidates && Array.isArray(chunk.candidates)) {
      for (const candidate of chunk.candidates) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined) {
              if (part.thought) {
                thoughtText += part.text;
              } else {
                text += part.text;
              }
            } else if (part.functionCall) {
              otherParts.push({ functionCall: part.functionCall });
            } else if (part.codeExecutionResult) {
              otherParts.push({
                codeExecutionResult: part.codeExecutionResult,
              });
            } else if (part.executableCode) {
              otherParts.push({ executableCode: part.executableCode });
            }
          }
        }
      }
    }
  }

  const aggregated: Record<string, unknown> = {};

  const parts: Record<string, unknown>[] = [];
  if (thoughtText) {
    parts.push({ text: thoughtText, thought: true });
  }
  if (text) {
    parts.push({ text });
  }
  parts.push(...otherParts);

  if (parts.length > 0 && lastResponse?.candidates) {
    const candidates: Record<string, unknown>[] = [];
    for (const candidate of lastResponse.candidates) {
      const candidateDict: Record<string, unknown> = {
        content: {
          parts,
          role: "model",
        },
      };

      if (candidate.finishReason !== undefined) {
        candidateDict.finishReason = candidate.finishReason;
      }
      if (candidate.groundingMetadata !== undefined) {
        candidateDict.groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata === undefined) {
          groundingMetadata = candidate.groundingMetadata;
        }
      }
      if (candidate.safetyRatings) {
        candidateDict.safetyRatings = candidate.safetyRatings;
      }

      candidates.push(candidateDict);
    }
    aggregated.candidates = candidates;
  }

  if (usageMetadata) {
    aggregated.usageMetadata = usageMetadata;
    populateUsageMetrics(metrics, usageMetadata);
  }
  if (groundingMetadata !== undefined) {
    aggregated.groundingMetadata = groundingMetadata;
  }

  if (text) {
    aggregated.text = text;
  }

  return { aggregated, metrics };
}

function aggregateInteractionEvents(
  chunks: GoogleGenAIInteractionSSEEvent[],
  startTime?: number,
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  const end = getCurrentUnixTimestamp();
  const metrics: Record<string, number> = {};
  if (startTime !== undefined) {
    metrics.start = startTime;
    metrics.end = end;
    metrics.duration = end - startTime;
  }

  let latestInteraction: Record<string, unknown> | undefined;
  let latestUsage: GoogleGenAIInteractionUsage | undefined;
  let status: string | undefined;
  let outputText = "";
  const steps = new Map<number, Record<string, unknown>>();

  for (const chunk of chunks) {
    const event = tryToDict(chunk);
    if (!event) {
      continue;
    }

    const usage = extractInteractionUsageFromEvent(event);
    if (usage) {
      latestUsage = usage;
    }

    const interaction = tryToDict(event.interaction);
    if (interaction) {
      latestInteraction = serializeInteractionValue(interaction) as Record<
        string,
        unknown
      >;
      if (typeof interaction.status === "string") {
        status = interaction.status;
      }
    }

    if (typeof event.status === "string") {
      status = event.status;
    }

    const index = typeof event.index === "number" ? event.index : undefined;
    if (index === undefined) {
      continue;
    }

    if (event.event_type === "step.start") {
      const compact = compactInteractionStep(event.step);
      compact.index = index;
      steps.set(index, compact);
      continue;
    }

    if (event.event_type === "step.delta") {
      const step = steps.get(index) ?? { index };
      const textDelta = applyInteractionDelta(step, event.delta);
      if (textDelta) {
        outputText += textDelta;
      }
      steps.set(index, step);
    }
  }

  if (latestUsage) {
    populateInteractionUsageMetrics(metrics, latestUsage);
  }

  const output: Record<string, unknown> = latestInteraction
    ? { ...latestInteraction }
    : {};
  if (status) {
    output.status = status;
  }
  if (outputText) {
    output.output_text = outputText;
  }
  if (latestUsage) {
    output.usage = serializeInteractionValue(latestUsage);
  }

  const compactSteps = Array.from(steps.values()).sort(
    (left, right) => Number(left.index ?? 0) - Number(right.index ?? 0),
  );
  if (compactSteps.length > 0) {
    output.steps = compactSteps;
  }

  const metadata: Record<string, unknown> = {};
  if (typeof output.id === "string") {
    metadata.interaction_id = output.id;
  }
  if (typeof output.status === "string") {
    metadata.status = output.status;
  }

  return {
    output,
    metrics: cleanMetrics(metrics),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function extractInteractionUsageFromEvent(
  event: Record<string, unknown>,
): GoogleGenAIInteractionUsage | undefined {
  const metadata = tryToDict(event.metadata);
  const metadataUsage = tryToDict(metadata?.usage);
  if (metadataUsage) {
    return metadataUsage as GoogleGenAIInteractionUsage;
  }
  const metadataTotalUsage = tryToDict(metadata?.total_usage);
  if (metadataTotalUsage) {
    return metadataTotalUsage as GoogleGenAIInteractionUsage;
  }

  const interaction = tryToDict(event.interaction);
  const interactionUsage = tryToDict(interaction?.usage);
  return interactionUsage
    ? (interactionUsage as GoogleGenAIInteractionUsage)
    : undefined;
}

function compactInteractionStep(step: unknown): Record<string, unknown> {
  const stepDict = tryToDict(step);
  if (!stepDict) {
    return {};
  }

  const compact: Record<string, unknown> = {};
  for (const key of [
    "type",
    "content",
    "name",
    "server_name",
    "arguments",
    "result",
    "is_error",
  ]) {
    if (stepDict[key] !== undefined) {
      compact[key] = serializeInteractionValue(stepDict[key]);
    }
  }

  return Object.keys(compact).length > 0
    ? compact
    : (serializeInteractionValue(stepDict) as Record<string, unknown>);
}

function applyInteractionDelta(
  step: Record<string, unknown>,
  delta: unknown,
): string | undefined {
  const deltaDict = tryToDict(delta);
  if (!deltaDict) {
    return undefined;
  }

  const deltaType = deltaDict.type;
  if (typeof deltaType === "string" && typeof step.type !== "string") {
    step.type = deltaType === "text" ? "model_output" : deltaType;
  }

  if (deltaType === "text" && typeof deltaDict.text === "string") {
    step.text = `${typeof step.text === "string" ? step.text : ""}${
      deltaDict.text
    }`;
    return deltaDict.text;
  }

  if (
    deltaType === "arguments_delta" &&
    typeof deltaDict.arguments === "string"
  ) {
    step.arguments = `${
      typeof step.arguments === "string" ? step.arguments : ""
    }${deltaDict.arguments}`;
    return undefined;
  }

  const deltas = Array.isArray(step.deltas) ? step.deltas : [];
  deltas.push(serializeInteractionValue(deltaDict));
  step.deltas = deltas;
  return undefined;
}

function cleanMetrics(metrics: Record<string, number>): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function extractResponseMetadata(
  response: unknown,
): Record<string, unknown> | undefined {
  const responseDict = tryToDict(response);
  if (!responseDict) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  const responseGroundingMetadata = responseDict.groundingMetadata;
  const candidateGroundingMetadata: unknown[] = [];

  if (Array.isArray(responseDict.candidates)) {
    for (const candidate of responseDict.candidates) {
      const candidateDict = tryToDict(candidate);
      if (candidateDict?.groundingMetadata !== undefined) {
        candidateGroundingMetadata.push(candidateDict.groundingMetadata);
      }
    }
  }

  if (responseGroundingMetadata !== undefined) {
    metadata.groundingMetadata = responseGroundingMetadata;
  } else if (candidateGroundingMetadata.length === 1) {
    [metadata.groundingMetadata] = candidateGroundingMetadata;
  } else if (candidateGroundingMetadata.length > 1) {
    metadata.groundingMetadata = candidateGroundingMetadata;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Helper to convert objects to dictionaries.
 */
function tryToDict(obj: unknown): Record<string, unknown> | null {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj === "object") {
    if (
      "toJSON" in obj &&
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      typeof (obj as Record<string, unknown>).toJSON === "function"
    ) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return (obj as { toJSON: () => Record<string, unknown> }).toJSON();
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return obj as Record<string, unknown>;
  }

  return null;
}
