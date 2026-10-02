import { debugLogger } from "../../debug-logger";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import {
  _internalGetGlobalState,
  BRAINTRUST_CURRENT_SPAN_STORE,
  startSpan,
} from "../../logger";
import type { CurrentSpanStore, Span } from "../../logger";
import {
  withSpanInstrumentationName,
  type SpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp, isObject } from "../../util";
import type {
  AnyAsyncChannel,
  AnySyncStreamChannel,
  ArgsOf,
  AsyncEndOf,
  ChannelMessage,
  ChunkOf,
  EndOf,
  ErrorOf,
  ResultOf,
  StartOf,
} from "./channel-definitions";
import { isAsyncIterable, patchStreamIfNeeded } from "./stream-patcher";
import {
  buildStartSpanArgs,
  mergeInputMetadata,
  type ChannelConfig,
} from "./channel-tracing-utils";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";

type SpanState = {
  span: Span;
  startTime: number;
};

type InputConfig<TChannel extends AnyAsyncChannel | AnySyncStreamChannel> =
  ChannelConfig & {
    extractInput: (
      args: [...ArgsOf<TChannel>, ...any[]],
      event: StartOf<TChannel>,
      span: Span,
    ) => {
      input: unknown;
      metadata: unknown;
    };
  };

type AsyncChannelSpanConfig<TChannel extends AnyAsyncChannel> =
  InputConfig<TChannel> & {
    extractOutput: (
      result: ResultOf<TChannel>,
      endEvent?: AsyncEndOf<TChannel>,
    ) => unknown;
    extractMetadata?: (
      result: ResultOf<TChannel>,
      endEvent?: AsyncEndOf<TChannel>,
    ) => unknown;
    extractMetrics: (
      result: ResultOf<TChannel>,
      startTime?: number,
      endEvent?: AsyncEndOf<TChannel>,
    ) => Record<string, number>;
  };

type StreamingResult<TChannel extends AnyAsyncChannel> = Exclude<
  ResultOf<TChannel>,
  AsyncIterable<unknown>
>;

type StreamingChannelSpanConfig<TChannel extends AnyAsyncChannel> =
  InputConfig<TChannel> & {
    extractOutput: (
      result: StreamingResult<TChannel>,
      endEvent?: AsyncEndOf<TChannel>,
    ) => unknown;
    extractMetadata?: (
      result: StreamingResult<TChannel>,
      endEvent?: AsyncEndOf<TChannel>,
    ) => unknown;
    extractMetrics: (
      result: StreamingResult<TChannel>,
      startTime?: number,
      endEvent?: AsyncEndOf<TChannel>,
    ) => Record<string, number>;
    aggregateChunks?: (
      chunks: ChunkOf<TChannel>[],
      result?: ResultOf<TChannel>,
      endEvent?: AsyncEndOf<TChannel>,
      startTime?: number,
    ) => {
      output: unknown;
      metrics: Record<string, number>;
      metadata?: Record<string, unknown>;
    };
    patchResult?: (args: {
      channelName: string;
      endEvent: AsyncEndOf<TChannel>;
      result: StreamingResult<TChannel>;
      span: Span;
      startTime: number;
    }) => boolean;
    onComplete?: (args: {
      channelName: string;
      chunks?: ChunkOf<TChannel>[];
      endEvent: AsyncEndOf<TChannel>;
      metadata?: Record<string, unknown>;
      metrics: Record<string, number>;
      output: unknown;
      result: StreamingResult<TChannel>;
      span: Span;
      startTime: number;
    }) => void;
    onError?: (args: {
      channelName: string;
      error: Error;
      event: AsyncEndOf<TChannel> | ErrorOf<TChannel>;
      span: Span;
      startTime: number;
    }) => void;
  };

type SyncStreamChannelSpanConfig<TChannel extends AnySyncStreamChannel> =
  InputConfig<TChannel> & {
    extractFromEvent?: (event: ChunkOf<TChannel>) => {
      output?: unknown;
      metrics?: Record<string, number>;
      metadata?: Record<string, unknown>;
    };
    patchResult?: (args: {
      channelName: string;
      endEvent: EndOf<TChannel>;
      result: ResultOf<TChannel>;
      span: Span;
      startTime: number;
    }) => boolean;
  };

type SyncStreamLike<TStreamEvent> = {
  on(event: "chunk", handler: (payload?: unknown) => void): unknown;
  on(
    event: "chatCompletion",
    handler: (payload?: { choices?: unknown }) => void,
  ): unknown;
  on(event: "event", handler: (payload: TStreamEvent) => void): unknown;
  on(event: "end", handler: () => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
};

function isSyncStreamLike<TStreamEvent>(
  value: unknown,
): value is SyncStreamLike<TStreamEvent> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { on?: unknown }).on === "function"
  );
}

function hasChoices(value: unknown): value is { choices?: unknown } {
  return !!value && typeof value === "object" && "choices" in value;
}

function normalizeMetadata(
  metadata: unknown,
): Record<string, unknown> | undefined {
  return isObject(metadata) ? (metadata as Record<string, unknown>) : undefined;
}

function startSpanForEvent<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(
  config: InputConfig<TChannel>,
  event: StartOf<TChannel>,
  channelName: string,
  instrumentationName: SpanInstrumentationName,
): SpanState {
  const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
    config,
    event,
  );
  const spanArgs = withSpanInstrumentationName(
    {
      name,
      spanAttributes,
    },
    instrumentationName,
  );
  let span: Span;
  try {
    span = config.startSpan?.(spanArgs) ?? startSpan(spanArgs);
  } catch (error) {
    debugLogger.error(`Error starting span for ${channelName}:`, error);
    span = startSpan(spanArgs);
  }
  const startTime = getCurrentUnixTimestamp();

  try {
    const { input, metadata } = config.extractInput(
      event.arguments,
      event as StartOf<TChannel>,
      span,
    );
    span.log({
      input,
      metadata: mergeInputMetadata(metadata, spanInfoMetadata),
    });
  } catch (error) {
    debugLogger.error(`Error extracting input for ${channelName}:`, error);
  }

  return { span, startTime };
}

function shouldTraceEvent<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(
  config: ChannelConfig,
  event: StartOf<TChannel>,
  channelName: string,
): boolean {
  if (!config.shouldTrace) {
    return true;
  }

  try {
    return config.shouldTrace(event.arguments, event);
  } catch (error) {
    debugLogger.error(
      `Error checking trace predicate for ${channelName}:`,
      error,
    );
    return true;
  }
}

function ensureSpanStateForEvent<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(
  states: WeakMap<object, SpanState>,
  config: InputConfig<TChannel>,
  event: StartOf<TChannel>,
  channelName: string,
  instrumentationName: SpanInstrumentationName,
): SpanState | undefined {
  const key = event as object;
  const existing = states.get(key);
  if (existing) {
    return existing;
  }

  if (!shouldTraceEvent<TChannel>(config, event, channelName)) {
    return undefined;
  }

  const created = startSpanForEvent<TChannel>(
    config,
    event,
    channelName,
    instrumentationName,
  );
  states.set(key, created);
  return created;
}

function getCurrentSpanStore() {
  const contextManager = _internalGetGlobalState()?.contextManager;
  const store = contextManager
    ? (
        contextManager as {
          [BRAINTRUST_CURRENT_SPAN_STORE]?: CurrentSpanStore;
        }
      )[BRAINTRUST_CURRENT_SPAN_STORE]
    : undefined;
  return contextManager && store ? { contextManager, store } : undefined;
}

function bindCurrentSpanStoreToStart<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(
  tracingChannel: IsoTracingChannel<ChannelMessage<TChannel>>,
  states: WeakMap<object, SpanState>,
  config: InputConfig<TChannel>,
  channelName: string,
  instrumentationName: SpanInstrumentationName,
): (() => void) | undefined {
  const currentSpanStore = getCurrentSpanStore();
  const startChannel = tracingChannel.start;
  if (!currentSpanStore || !startChannel) {
    return undefined;
  }
  const { contextManager, store } = currentSpanStore;

  startChannel.bindStore(store, (event: ChannelMessage<TChannel>) => {
    if (isAutoInstrumentationSuppressed()) {
      return store.getStore();
    }

    const spanState = ensureSpanStateForEvent<TChannel>(
      states,
      config,
      event as StartOf<TChannel>,
      channelName,
      instrumentationName,
    );
    return spanState
      ? contextManager.wrapSpanForStore(spanState.span)
      : store.getStore();
  });

  return () => {
    startChannel.unbindStore(store);
  };
}

function takeSpanState(
  states: WeakMap<object, SpanState>,
  event: object,
): SpanState | undefined {
  const spanState = states.get(event);
  states.delete(event);
  return spanState;
}

function logErrorAndEnd(
  { span }: SpanState,
  error: unknown,
  channelName: string,
): void {
  try {
    span.log({ error });
  } catch (loggingError) {
    debugLogger.error(
      `Error logging failure for ${channelName}:`,
      loggingError,
    );
  }
  try {
    span.end();
  } catch (endingError) {
    debugLogger.error(`Error ending span for ${channelName}:`, endingError);
  }
}

function runStreamingCompletionHook<TChannel extends AnyAsyncChannel>(args: {
  channelName: string;
  config: StreamingChannelSpanConfig<TChannel>;
  chunks?: ChunkOf<TChannel>[];
  endEvent: AsyncEndOf<TChannel>;
  metadata?: Record<string, unknown>;
  metrics: Record<string, number>;
  output: unknown;
  result: StreamingResult<TChannel>;
  span: Span;
  startTime: number;
}): void {
  if (!args.config.onComplete) {
    return;
  }

  try {
    args.config.onComplete({
      channelName: args.channelName,
      ...(args.chunks ? { chunks: args.chunks } : {}),
      endEvent: args.endEvent,
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      metrics: args.metrics,
      output: args.output,
      result: args.result,
      span: args.span,
      startTime: args.startTime,
    });
  } catch (error) {
    debugLogger.error(
      `Error in onComplete hook for ${args.channelName}:`,
      error,
    );
  }
}

function failStreamingSpan<TChannel extends AnyAsyncChannel>(
  config: StreamingChannelSpanConfig<TChannel>,
  spanState: SpanState,
  event: AsyncEndOf<TChannel> | ErrorOf<TChannel>,
  error: Error,
  channelName: string,
): void {
  logErrorAndEnd(spanState, error, channelName);
  if (!config.onError) {
    return;
  }

  try {
    config.onError({
      channelName,
      error,
      event,
      span: spanState.span,
      startTime: spanState.startTime,
    });
  } catch (hookError) {
    debugLogger.error(`Error in onError hook for ${channelName}:`, hookError);
  }
}

function finishAsyncSpan<TChannel extends AnyAsyncChannel>(
  config: AsyncChannelSpanConfig<TChannel>,
  { span, startTime }: SpanState,
  event: AsyncEndOf<TChannel>,
  channelName: string,
): void {
  try {
    const output = config.extractOutput(event.result, event);
    const metrics = config.extractMetrics(event.result, startTime, event);
    const metadata = config.extractMetadata?.(event.result, event);

    span.log({
      output,
      ...(normalizeMetadata(metadata) !== undefined
        ? { metadata: normalizeMetadata(metadata) }
        : {}),
      metrics,
    });
  } catch (error) {
    debugLogger.error(`Error extracting output for ${channelName}:`, error);
  } finally {
    span.end();
  }
}

function finishStreamingSpan<TChannel extends AnyAsyncChannel>(
  config: StreamingChannelSpanConfig<TChannel>,
  spanState: SpanState,
  asyncEndEvent: AsyncEndOf<TChannel>,
  channelName: string,
): void {
  const { span, startTime } = spanState;

  if (isAsyncIterable(asyncEndEvent.result)) {
    let firstChunkTime: number | undefined;
    const handleStreamError = (error: Error) =>
      failStreamingSpan(config, spanState, asyncEndEvent, error, channelName);

    patchStreamIfNeeded(asyncEndEvent.result, {
      onChunk: () => {
        if (firstChunkTime === undefined) {
          firstChunkTime = getCurrentUnixTimestamp();
        }
      },
      onComplete: (chunks: ChunkOf<TChannel>[]) => {
        let completion:
          | {
              metadata?: Record<string, unknown>;
              metrics: Record<string, number>;
              output: unknown;
            }
          | undefined;
        try {
          let output: unknown;
          let metrics: Record<string, number>;
          let metadata: Record<string, unknown> | undefined;

          if (config.aggregateChunks) {
            const aggregated = config.aggregateChunks(
              chunks,
              asyncEndEvent.result,
              asyncEndEvent,
              startTime,
            );
            output = aggregated.output;
            metrics = aggregated.metrics;
            metadata = aggregated.metadata;
          } else {
            output = config.extractOutput(
              chunks as unknown as StreamingResult<TChannel>,
              asyncEndEvent,
            );
            metrics = config.extractMetrics(
              chunks as unknown as StreamingResult<TChannel>,
              startTime,
              asyncEndEvent,
            );
          }

          if (
            metrics.time_to_first_token === undefined &&
            firstChunkTime !== undefined
          ) {
            metrics.time_to_first_token = firstChunkTime - startTime;
          } else if (
            metrics.time_to_first_token === undefined &&
            chunks.length > 0
          ) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }

          completion = {
            ...(metadata !== undefined ? { metadata } : {}),
            metrics,
            output,
          };
          span.log({
            output,
            ...(metadata !== undefined ? { metadata } : {}),
            metrics,
          });
        } catch (error) {
          debugLogger.error(
            `Error extracting output for ${channelName}:`,
            error,
          );
        } finally {
          try {
            span.end();
          } catch (error) {
            debugLogger.error(`Error ending span for ${channelName}:`, error);
          }
        }
        if (completion) {
          runStreamingCompletionHook<TChannel>({
            channelName,
            chunks,
            config,
            endEvent: asyncEndEvent,
            ...(completion.metadata !== undefined
              ? { metadata: completion.metadata }
              : {}),
            metrics: completion.metrics,
            output: completion.output,
            result: asyncEndEvent.result as StreamingResult<TChannel>,
            span,
            startTime,
          });
        }
      },
      onCancel: () => {
        const error = new Error("Stream cancelled before completion");
        error.name = "AbortError";
        handleStreamError(error);
      },
      onError: handleStreamError,
    });
    return;
  }

  if (
    config.patchResult?.({
      channelName,
      endEvent: asyncEndEvent,
      result: asyncEndEvent.result as StreamingResult<TChannel>,
      span,
      startTime,
    })
  ) {
    return;
  }

  let completion:
    | {
        metadata?: Record<string, unknown>;
        metrics: Record<string, number>;
        output: unknown;
      }
    | undefined;
  try {
    const output = config.extractOutput(
      asyncEndEvent.result as StreamingResult<TChannel>,
      asyncEndEvent,
    );
    const metrics = config.extractMetrics(
      asyncEndEvent.result as StreamingResult<TChannel>,
      startTime,
      asyncEndEvent,
    );
    const metadata = config.extractMetadata?.(
      asyncEndEvent.result as StreamingResult<TChannel>,
      asyncEndEvent,
    );

    completion = {
      ...(normalizeMetadata(metadata) !== undefined
        ? { metadata: normalizeMetadata(metadata) }
        : {}),
      metrics,
      output,
    };
    span.log({
      output,
      ...(normalizeMetadata(metadata) !== undefined
        ? { metadata: normalizeMetadata(metadata) }
        : {}),
      metrics,
    });
  } catch (error) {
    debugLogger.error(`Error extracting output for ${channelName}:`, error);
  } finally {
    try {
      span.end();
    } catch (error) {
      debugLogger.error(`Error ending span for ${channelName}:`, error);
    }
  }
  if (completion) {
    runStreamingCompletionHook<TChannel>({
      channelName,
      config,
      endEvent: asyncEndEvent,
      ...(completion.metadata !== undefined
        ? { metadata: completion.metadata }
        : {}),
      metrics: completion.metrics,
      output: completion.output,
      result: asyncEndEvent.result as StreamingResult<TChannel>,
      span,
      startTime,
    });
  }
}

function finishSyncStreamSpan<TChannel extends AnySyncStreamChannel>(
  config: SyncStreamChannelSpanConfig<TChannel>,
  { span, startTime }: SpanState,
  endEvent: EndOf<TChannel>,
  channelName: string,
): void {
  const result = endEvent.result;
  if (
    config.patchResult?.({
      channelName,
      endEvent: { ...endEvent, result } as EndOf<TChannel>,
      result,
      span,
      startTime,
    })
  ) {
    return;
  }

  const stream = result;

  if (!isSyncStreamLike<ChunkOf<TChannel>>(stream)) {
    span.end();
    return;
  }

  let first = true;

  stream.on("chunk", () => {
    if (first) {
      span.log({
        metrics: {
          time_to_first_token: getCurrentUnixTimestamp() - startTime,
        },
      });
      first = false;
    }
  });

  stream.on("chatCompletion", (completion) => {
    try {
      if (hasChoices(completion)) {
        span.log({
          output: completion.choices,
        });
      }
    } catch (error) {
      debugLogger.error(
        `Error extracting chatCompletion for ${channelName}:`,
        error,
      );
    }
  });

  stream.on("event", (streamEvent) => {
    if (!config.extractFromEvent) {
      return;
    }

    try {
      if (first) {
        span.log({
          metrics: {
            time_to_first_token: getCurrentUnixTimestamp() - startTime,
          },
        });
        first = false;
      }

      const extracted = config.extractFromEvent(streamEvent);
      if (extracted && Object.keys(extracted).length > 0) {
        span.log(extracted);
      }
    } catch (error) {
      debugLogger.error(`Error extracting event for ${channelName}:`, error);
    }
  });

  stream.on("end", () => {
    span.end();
  });

  stream.on("error", (error: Error) => {
    span.log({
      error: error.message,
    });
    span.end();
  });
}

function subscribeTracingChannel<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(
  channel: TChannel,
  config: InputConfig<TChannel>,
  handlers: (
    states: WeakMap<object, SpanState>,
  ) => IsoChannelHandlers<ChannelMessage<TChannel>>,
): () => void {
  const tracingChannel = channel.tracingChannel() as IsoTracingChannel<
    ChannelMessage<TChannel>
  >;
  const states = new WeakMap<object, SpanState>();
  const { channelName, instrumentationName } = channel;
  const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
    tracingChannel,
    states,
    config,
    channelName,
    instrumentationName,
  );
  const subscribedHandlers: IsoChannelHandlers<ChannelMessage<TChannel>> = {
    start: (event) => {
      if (isAutoInstrumentationSuppressed()) {
        return;
      }

      ensureSpanStateForEvent<TChannel>(
        states,
        config,
        event as StartOf<TChannel>,
        channelName,
        instrumentationName,
      );
    },
    ...handlers(states),
  };

  tracingChannel.subscribe(subscribedHandlers);

  return () => {
    unbindCurrentSpanStore?.();
    tracingChannel.unsubscribe(subscribedHandlers);
  };
}

export function traceAsyncChannel<TChannel extends AnyAsyncChannel>(
  channel: TChannel,
  config: AsyncChannelSpanConfig<TChannel>,
): () => void {
  const { channelName } = channel;
  return subscribeTracingChannel(channel, config, (states) => ({
    asyncEnd: (event) => {
      const spanState = takeSpanState(states, event);
      if (spanState) {
        finishAsyncSpan(
          config,
          spanState,
          event as AsyncEndOf<TChannel>,
          channelName,
        );
      }
    },
    error: (event) => {
      const spanState = takeSpanState(states, event);
      if (spanState) {
        logErrorAndEnd(spanState, event.error, channelName);
      }
    },
  }));
}

export function traceStreamingChannel<TChannel extends AnyAsyncChannel>(
  channel: TChannel,
  config: StreamingChannelSpanConfig<TChannel>,
): () => void {
  const { channelName } = channel;
  return subscribeTracingChannel(channel, config, (states) => ({
    asyncEnd: (event) => {
      const spanState = takeSpanState(states, event);
      if (spanState) {
        finishStreamingSpan(
          config,
          spanState,
          event as AsyncEndOf<TChannel>,
          channelName,
        );
      }
    },
    error: (event) => {
      const spanState = takeSpanState(states, event);
      if (spanState) {
        const errorEvent = event as ErrorOf<TChannel>;
        failStreamingSpan(
          config,
          spanState,
          errorEvent,
          errorEvent.error,
          channelName,
        );
      }
    },
  }));
}

export function traceSyncStreamChannel<TChannel extends AnySyncStreamChannel>(
  channel: TChannel,
  config: SyncStreamChannelSpanConfig<TChannel>,
): () => void {
  const { channelName } = channel;
  return subscribeTracingChannel(channel, config, (states) => ({
    end: (event) => {
      const spanState = takeSpanState(states, event);
      if (spanState) {
        finishSyncStreamSpan(
          config,
          spanState,
          event as EndOf<TChannel>,
          channelName,
        );
      }
    },
    error: (event) => {
      const spanState = takeSpanState(states, event);
      if (spanState) {
        logErrorAndEnd(spanState, event.error, channelName);
      }
    },
  }));
}

type InterceptableChannel = {
  channelName: string;
  instrumentationName: SpanInstrumentationName;
  intercept(
    interceptor: (
      target: (this: unknown, ...args: any[]) => any,
      thisArg: unknown,
      args: any[],
      additional: object,
    ) => any,
  ): () => void;
};

/**
 * Intercepts calls with the same span lifecycle as the legacy trace helpers.
 * The event mirrors the generated wrapper context: additional fields plus the
 * actual arguments and receiver, with `result` or `error` set on completion.
 */
function interceptChannel<
  TChannel extends (AnyAsyncChannel | AnySyncStreamChannel) &
    InterceptableChannel,
>(
  channel: TChannel,
  config: InputConfig<TChannel>,
  finish: (spanState: SpanState, event: ChannelMessage<TChannel>) => void,
  fail: (spanState: SpanState, event: ChannelMessage<TChannel>) => void,
): () => void {
  const { channelName, instrumentationName } = channel;
  const currentSpanStore = getCurrentSpanStore();
  return channel.intercept((target, thisArg, args, additional) => {
    const callTarget = () => Reflect.apply(target, thisArg, args);
    if (isAutoInstrumentationSuppressed()) {
      return callTarget();
    }

    let event: ChannelMessage<TChannel> | undefined;
    let startedSpan: SpanState | undefined;
    try {
      event = {
        ...additional,
        arguments: args,
        self: thisArg,
      } as unknown as ChannelMessage<TChannel>;
      if (shouldTraceEvent<TChannel>(config, event, channelName)) {
        startedSpan = startSpanForEvent<TChannel>(
          config,
          event,
          channelName,
          instrumentationName,
        );
      }
    } catch (error) {
      debugLogger.error(`Error starting span for ${channelName}:`, error);
    }
    if (!event || !startedSpan) {
      return callTarget();
    }
    const tracedEvent = event;
    const spanState = startedSpan;

    let settled = false;
    const settle = (key: "result" | "error", value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        Object.assign(tracedEvent, { [key]: value });
        (key === "result" ? finish : fail)(spanState, tracedEvent);
      } catch (error) {
        debugLogger.error(`Error tracing ${channelName}:`, error);
      }
    };

    // Mirrors the global hook runtime's traceSync/tracePromise: the target and
    // the result observation (including promise reaction registration) share
    // the span scope. Plain promises are chained, while promise subclasses and
    // other thenables are observed on a side chain and returned unchanged.
    const callAndObserve = () => {
      let result: unknown;
      try {
        result = callTarget();
      } catch (error) {
        settle("error", error);
        throw error;
      }
      if (channel.kind !== "async") {
        settle("result", result);
        return result;
      }

      try {
        const then =
          (typeof result === "object" && result !== null) ||
          typeof result === "function"
            ? (result as { then?: unknown }).then
            : undefined;
        if (typeof then === "function") {
          const onResult = (value: unknown) => {
            settle("result", value);
            return value;
          };
          if (result instanceof Promise && result.constructor === Promise) {
            return Reflect.apply(then, result, [
              onResult,
              (error: unknown) => {
                settle("error", error);
                throw error;
              },
            ]);
          }
          Reflect.apply(then, result, [
            onResult,
            (error: unknown) => settle("error", error),
          ]);
          return result;
        }
      } catch (error) {
        debugLogger.error(`Error observing result for ${channelName}:`, error);
      }
      settle("result", result);
      return result;
    };

    // Like the runtime's store binding, a failed context lookup still runs the
    // provider, just without the span as its current context.
    let storeValue: unknown;
    try {
      storeValue = currentSpanStore?.contextManager.wrapSpanForStore(
        spanState.span,
      );
    } catch (error) {
      debugLogger.error(`Error binding span for ${channelName}:`, error);
      return callAndObserve();
    }
    return currentSpanStore
      ? currentSpanStore.store.run(storeValue, callAndObserve)
      : callAndObserve();
  });
}

export function interceptAsyncChannel<
  TChannel extends AnyAsyncChannel & InterceptableChannel,
>(channel: TChannel, config: AsyncChannelSpanConfig<TChannel>): () => void {
  return interceptChannel(
    channel,
    config,
    (spanState, event) =>
      finishAsyncSpan(
        config,
        spanState,
        event as AsyncEndOf<TChannel>,
        channel.channelName,
      ),
    (spanState, event) =>
      logErrorAndEnd(spanState, event.error, channel.channelName),
  );
}

export function interceptStreamingChannel<
  TChannel extends AnyAsyncChannel & InterceptableChannel,
>(channel: TChannel, config: StreamingChannelSpanConfig<TChannel>): () => void {
  return interceptChannel(
    channel,
    config,
    (spanState, event) =>
      finishStreamingSpan(
        config,
        spanState,
        event as AsyncEndOf<TChannel>,
        channel.channelName,
      ),
    (spanState, event) => {
      const errorEvent = event as ErrorOf<TChannel>;
      failStreamingSpan(
        config,
        spanState,
        errorEvent,
        errorEvent.error,
        channel.channelName,
      );
    },
  );
}

export function interceptSyncStreamChannel<
  TChannel extends AnySyncStreamChannel & InterceptableChannel,
>(
  channel: TChannel,
  config: SyncStreamChannelSpanConfig<TChannel>,
): () => void {
  return interceptChannel(
    channel,
    config,
    (spanState, event) =>
      finishSyncStreamSpan(
        config,
        spanState,
        event as EndOf<TChannel>,
        channel.channelName,
      ),
    (spanState, event) =>
      logErrorAndEnd(spanState, event.error, channel.channelName),
  );
}

export function unsubscribeAll(
  unsubscribers: Array<() => void>,
): Array<() => void> {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }

  return [];
}
