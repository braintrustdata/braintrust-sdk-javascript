import { debugLogger } from "../../debug-logger";
import type { Span } from "../../logger";
import { startSpan, withCurrent } from "../../logger";
import {
  withSpanInstrumentationName,
  type SpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp, isObject } from "../../util";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import type { ArgsOf, ChunkOf, ReturnOf } from "./channel-definitions";
import {
  buildStartSpanArgs,
  mergeInputMetadata,
  type ChannelConfig,
} from "./channel-tracing-utils";
import { observeResult, runInstrumentation } from "./observe-result";
import { isAsyncIterable, patchStreamIfNeeded } from "./stream-patcher";
import type {
  AnyAsyncChannel,
  AnySyncStreamChannel,
  AsyncEndOf,
  EndOf,
  ErrorOf,
  ResultOf,
  StartOf,
} from "./tracing-types";

type SpanState = {
  span: Span;
  startTime: number;
};

type AsyncChannelSpanConfig<TChannel extends AnyAsyncChannel> =
  ChannelConfig & {
    extractInput: (
      args: [...ArgsOf<TChannel>, ...any[]],
      event: StartOf<TChannel>,
      span: Span,
    ) => {
      input: unknown;
      metadata: unknown;
    };
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
  ChannelConfig & {
    extractInput: (
      args: [...ArgsOf<TChannel>, ...any[]],
      event: StartOf<TChannel>,
      span: Span,
    ) => {
      input: unknown;
      metadata: unknown;
    };
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
      error?: string;
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
  ChannelConfig & {
    extractInput: (
      args: [...ArgsOf<TChannel>, ...any[]],
      event: StartOf<TChannel>,
      span: Span,
    ) => {
      input: unknown;
      metadata: unknown;
    };
    extractFromEvent?: (event: ChunkOf<TChannel>) => {
      output?: unknown;
      metrics?: Record<string, number>;
      metadata?: Record<string, unknown>;
      error?: string;
    };
    patchResult?: (args: {
      channelName: string;
      endEvent: EndOf<TChannel>;
      result: ReturnOf<TChannel>;
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
  config: ChannelConfig & {
    extractInput: (
      args: [...ArgsOf<TChannel>, ...any[]],
      event: StartOf<TChannel>,
      span: Span,
    ) => {
      input: unknown;
      metadata: unknown;
    };
  },
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

function runStreamingErrorHook<TChannel extends AnyAsyncChannel>(args: {
  channelName: string;
  config: StreamingChannelSpanConfig<TChannel>;
  error: Error;
  event: AsyncEndOf<TChannel> | ErrorOf<TChannel>;
  span: Span;
  startTime: number;
}): void {
  if (!args.config.onError) {
    return;
  }

  try {
    args.config.onError({
      channelName: args.channelName,
      error: args.error,
      event: args.event,
      span: args.span,
      startTime: args.startTime,
    });
  } catch (error) {
    debugLogger.error(`Error in onError hook for ${args.channelName}:`, error);
  }
}

export function traceAsyncCall<TChannel extends AnyAsyncChannel>(
  call: () => ReturnOf<TChannel>,
  event: StartOf<TChannel>,
  config: AsyncChannelSpanConfig<TChannel> & {
    instrumentationName: SpanInstrumentationName;
  },
): ReturnOf<TChannel> {
  const channelName =
    typeof config.name === "string" ? config.name : "provider call";
  if (
    isAutoInstrumentationSuppressed() ||
    !shouldTraceEvent(config, event, channelName)
  )
    return call();
  const spanData = runInstrumentation(() =>
    startSpanForEvent<TChannel>(
      config,
      event,
      channelName,
      config.instrumentationName,
    ),
  );
  if (!spanData) return call();
  const { span } = spanData;
  const complete = (event: AsyncEndOf<TChannel>) => {
    const asyncEndEvent = event as AsyncEndOf<TChannel>;
    const { span, startTime } = spanData;

    try {
      const output = config.extractOutput(asyncEndEvent.result, asyncEndEvent);
      const metrics = config.extractMetrics(
        asyncEndEvent.result,
        startTime,
        asyncEndEvent,
      );
      const metadata = config.extractMetadata?.(
        asyncEndEvent.result,
        asyncEndEvent,
      );

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
  };
  const fail = (error: unknown) => {
    span.log({ error });
    span.end();
  };
  let result: ReturnOf<TChannel>;
  try {
    result = withCurrent(span, call);
  } catch (error) {
    fail(error);
    throw error;
  }
  return withCurrent(span, () =>
    observeResult(
      result,
      (value) =>
        complete(
          Object.assign(event, { result: value }) as AsyncEndOf<TChannel>,
        ),
      fail,
    ),
  );
}

export function traceStreamingCall<TChannel extends AnyAsyncChannel>(
  call: () => ReturnOf<TChannel>,
  event: StartOf<TChannel>,
  config: StreamingChannelSpanConfig<TChannel> & {
    instrumentationName: SpanInstrumentationName;
  },
): ReturnOf<TChannel> {
  const channelName =
    typeof config.name === "string" ? config.name : "provider call";
  if (
    isAutoInstrumentationSuppressed() ||
    !shouldTraceEvent(config, event, channelName)
  )
    return call();
  const spanData = runInstrumentation(() =>
    startSpanForEvent<TChannel>(
      config,
      event,
      channelName,
      config.instrumentationName,
    ),
  );
  if (!spanData) return call();
  const { span, startTime } = spanData;
  const complete = (event: AsyncEndOf<TChannel>) => {
    const asyncEndEvent = event as AsyncEndOf<TChannel>;
    const { span, startTime } = spanData;

    if (isAsyncIterable(asyncEndEvent.result)) {
      let firstChunkTime: number | undefined;
      const handleStreamError = (error: Error) => {
        try {
          span.log({ error });
        } catch (loggingError) {
          debugLogger.error(
            `Error logging failure for ${channelName}:`,
            loggingError,
          );
        }
        span.end();

        runStreamingErrorHook<TChannel>({
          channelName,
          config,
          error,
          event: asyncEndEvent,
          span,
          startTime,
        });
      };

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
            let error: string | undefined;

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
              error = aggregated.error;
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
              metrics.time_to_first_token =
                getCurrentUnixTimestamp() - startTime;
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
              ...(error !== undefined ? { error } : {}),
            });
          } catch (error) {
            debugLogger.error(
              `Error extracting output for ${channelName}:`,
              error,
            );
          } finally {
            span.end();
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
      span.end();
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
  };
  const fail = (error: unknown) => {
    span.log({ error });
    span.end();
    runStreamingErrorHook<TChannel>({
      channelName,
      config,
      error: error as Error,
      event: { ...event, error } as ErrorOf<TChannel>,
      span,
      startTime,
    });
  };
  let result: ReturnOf<TChannel>;
  try {
    result = withCurrent(span, call);
  } catch (error) {
    fail(error);
    throw error;
  }
  return withCurrent(span, () =>
    observeResult(
      result,
      (value) =>
        complete(
          Object.assign(event, { result: value }) as AsyncEndOf<TChannel>,
        ),
      fail,
    ),
  );
}

export function traceSyncStreamCall<TChannel extends AnyAsyncChannel>(
  call: () => ReturnOf<TChannel>,
  event: StartOf<TChannel>,
  config: SyncStreamChannelSpanConfig<TChannel> & {
    instrumentationName: SpanInstrumentationName;
  },
): ReturnOf<TChannel> {
  const channelName =
    typeof config.name === "string" ? config.name : "provider call";
  if (
    isAutoInstrumentationSuppressed() ||
    !shouldTraceEvent(config, event, channelName)
  )
    return call();
  const spanData = runInstrumentation(() =>
    startSpanForEvent<TChannel>(
      config,
      event,
      channelName,
      config.instrumentationName,
    ),
  );
  if (!spanData) return call();
  const { span } = spanData;
  const complete = (event: EndOf<TChannel>) => {
    const { span, startTime } = spanData;
    const endEvent = event as EndOf<TChannel>;
    const handleResolvedResult = (result: ReturnOf<TChannel>) => {
      const resolvedEndEvent = {
        ...endEvent,
        result,
      } as EndOf<TChannel>;

      if (
        config.patchResult?.({
          channelName,
          endEvent: resolvedEndEvent,
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
          debugLogger.error(
            `Error extracting event for ${channelName}:`,
            error,
          );
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
    };

    handleResolvedResult(endEvent.result);
  };
  const fail = (error: unknown) => {
    span.log({ error });
    span.end();
  };
  let result: ReturnOf<TChannel>;
  try {
    result = withCurrent(span, call);
  } catch (error) {
    fail(error);
    throw error;
  }
  withCurrent(span, () =>
    runInstrumentation(() => complete({ ...event, result } as EndOf<TChannel>)),
  );
  return result;
}
export function unsubscribeAll(
  unsubscribers: Array<() => void>,
): Array<() => void> {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }

  return [];
}
