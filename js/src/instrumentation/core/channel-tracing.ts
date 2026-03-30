import type {
  IsoAsyncLocalStorage,
  IsoChannelHandlers,
  IsoTracingChannel,
} from "../../isomorph";
import {
  _internalGetGlobalState,
  BRAINTRUST_CURRENT_SPAN_STORE,
  startSpan,
} from "../../logger";
import type { Span } from "../../logger";
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

type SpanState = {
  span: Span;
  startTime: number;
};

export type AsyncChannelSpanConfig<TChannel extends AnyAsyncChannel> =
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

export type StreamingChannelSpanConfig<TChannel extends AnyAsyncChannel> =
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
    };
    patchResult?: (args: {
      channelName: string;
      endEvent: AsyncEndOf<TChannel>;
      result: StreamingResult<TChannel>;
      span: Span;
      startTime: number;
    }) => boolean;
  };

export type SyncStreamChannelSpanConfig<TChannel extends AnySyncStreamChannel> =
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
): SpanState {
  const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
    config,
    event,
  );
  const span = startSpan({
    name,
    spanAttributes,
  });
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
    console.error(`Error extracting input for ${channelName}:`, error);
  }

  return { span, startTime };
}

function ensureSpanStateForEvent<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(
  states: WeakMap<object, SpanState>,
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
): SpanState {
  const key = event as object;
  const existing = states.get(key);
  if (existing) {
    return existing;
  }

  const created = startSpanForEvent<TChannel>(config, event, channelName);
  states.set(key, created);
  return created;
}

function bindCurrentSpanStoreToStart<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(
  tracingChannel: IsoTracingChannel<ChannelMessage<TChannel>>,
  states: WeakMap<object, SpanState>,
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
  channelName: string,
): (() => void) | undefined {
  const state = _internalGetGlobalState();
  const startChannel = tracingChannel.start;
  const currentSpanStore = state?.contextManager
    ? (
        state.contextManager as {
          [BRAINTRUST_CURRENT_SPAN_STORE]?: IsoAsyncLocalStorage<Span>;
        }
      )[BRAINTRUST_CURRENT_SPAN_STORE]
    : undefined;

  if (!currentSpanStore || !startChannel) {
    return undefined;
  }

  startChannel.bindStore(
    currentSpanStore,
    (event: ChannelMessage<TChannel>) =>
      ensureSpanStateForEvent<TChannel>(
        states,
        config,
        event as StartOf<TChannel>,
        channelName,
      ).span,
  );

  return () => {
    startChannel.unbindStore(currentSpanStore);
  };
}

function logErrorAndEnd<
  TChannel extends AnyAsyncChannel | AnySyncStreamChannel,
>(states: WeakMap<object, SpanState>, event: ErrorOf<TChannel>): void {
  const spanData = states.get(event as object);
  if (!spanData) {
    return;
  }

  spanData.span.log({
    error: event.error.message,
  });
  spanData.span.end();
  states.delete(event as object);
}

export function traceAsyncChannel<TChannel extends AnyAsyncChannel>(
  channel: TChannel,
  config: AsyncChannelSpanConfig<TChannel>,
): () => void {
  const tracingChannel = channel.tracingChannel() as IsoTracingChannel<
    ChannelMessage<TChannel>
  >;
  const states = new WeakMap<object, SpanState>();
  const channelName = channel.channelName;
  const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
    tracingChannel,
    states,
    config,
    channelName,
  );

  const handlers: IsoChannelHandlers<ChannelMessage<TChannel>> = {
    start: (event) => {
      ensureSpanStateForEvent<TChannel>(
        states,
        config,
        event as StartOf<TChannel>,
        channelName,
      );
    },
    asyncEnd: (event) => {
      const spanData = states.get(event as object);
      if (!spanData) {
        return;
      }

      const asyncEndEvent = event as AsyncEndOf<TChannel>;
      const { span, startTime } = spanData;

      try {
        const output = config.extractOutput(
          asyncEndEvent.result,
          asyncEndEvent,
        );
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
        console.error(`Error extracting output for ${channelName}:`, error);
      } finally {
        span.end();
        states.delete(event as object);
      }
    },
    error: (event) => {
      logErrorAndEnd(states, event as ErrorOf<TChannel>);
    },
  };

  tracingChannel.subscribe(handlers);

  return () => {
    unbindCurrentSpanStore?.();
    tracingChannel.unsubscribe(handlers);
  };
}

export function traceStreamingChannel<TChannel extends AnyAsyncChannel>(
  channel: TChannel,
  config: StreamingChannelSpanConfig<TChannel>,
): () => void {
  const tracingChannel = channel.tracingChannel() as IsoTracingChannel<
    ChannelMessage<TChannel>
  >;
  const states = new WeakMap<object, SpanState>();
  const channelName = channel.channelName;
  const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
    tracingChannel,
    states,
    config,
    channelName,
  );

  const handlers: IsoChannelHandlers<ChannelMessage<TChannel>> = {
    start: (event) => {
      ensureSpanStateForEvent<TChannel>(
        states,
        config,
        event as StartOf<TChannel>,
        channelName,
      );
    },
    asyncEnd: (event) => {
      const spanData = states.get(event as object);
      if (!spanData) {
        return;
      }

      const asyncEndEvent = event as AsyncEndOf<TChannel>;
      const { span, startTime } = spanData;

      if (isAsyncIterable(asyncEndEvent.result)) {
        let firstChunkTime: number | undefined;

        patchStreamIfNeeded(asyncEndEvent.result, {
          onChunk: () => {
            if (firstChunkTime === undefined) {
              firstChunkTime = getCurrentUnixTimestamp();
            }
          },
          onComplete: (chunks: ChunkOf<TChannel>[]) => {
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
                metrics.time_to_first_token =
                  getCurrentUnixTimestamp() - startTime;
              }

              span.log({
                output,
                ...(metadata !== undefined ? { metadata } : {}),
                metrics,
              });
            } catch (error) {
              console.error(
                `Error extracting output for ${channelName}:`,
                error,
              );
            } finally {
              span.end();
              states.delete(event as object);
            }
          },
          onError: (error: Error) => {
            span.log({
              error: error.message,
            });
            span.end();
            states.delete(event as object);
          },
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
        states.delete(event as object);
        return;
      }

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

        span.log({
          output,
          ...(normalizeMetadata(metadata) !== undefined
            ? { metadata: normalizeMetadata(metadata) }
            : {}),
          metrics,
        });
      } catch (error) {
        console.error(`Error extracting output for ${channelName}:`, error);
      } finally {
        span.end();
        states.delete(event as object);
      }
    },
    error: (event) => {
      logErrorAndEnd(states, event as ErrorOf<TChannel>);
    },
  };

  tracingChannel.subscribe(handlers);

  return () => {
    unbindCurrentSpanStore?.();
    tracingChannel.unsubscribe(handlers);
  };
}

export function traceSyncStreamChannel<TChannel extends AnySyncStreamChannel>(
  channel: TChannel,
  config: SyncStreamChannelSpanConfig<TChannel>,
): () => void {
  const tracingChannel = channel.tracingChannel() as IsoTracingChannel<
    ChannelMessage<TChannel>
  >;
  const states = new WeakMap<object, SpanState>();
  const channelName = channel.channelName;
  const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
    tracingChannel,
    states,
    config,
    channelName,
  );

  const handlers: IsoChannelHandlers<ChannelMessage<TChannel>> = {
    start: (event) => {
      ensureSpanStateForEvent<TChannel>(
        states,
        config,
        event as StartOf<TChannel>,
        channelName,
      );
    },
    end: (event) => {
      const spanData = states.get(event as object);
      if (!spanData) {
        return;
      }

      const { span, startTime } = spanData;
      const endEvent = event as EndOf<TChannel>;

      if (
        config.patchResult?.({
          channelName,
          endEvent,
          result: endEvent.result,
          span,
          startTime,
        })
      ) {
        return;
      }

      const stream = endEvent.result;

      if (!isSyncStreamLike<ChunkOf<TChannel>>(stream)) {
        span.end();
        states.delete(event as object);
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
          console.error(
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
          console.error(`Error extracting event for ${channelName}:`, error);
        }
      });

      stream.on("end", () => {
        span.end();
        states.delete(event as object);
      });

      stream.on("error", (error: Error) => {
        span.log({
          error: error.message,
        });
        span.end();
        states.delete(event as object);
      });
    },
    error: (event) => {
      logErrorAndEnd(states, event as ErrorOf<TChannel>);
    },
  };

  tracingChannel.subscribe(handlers);

  return () => {
    unbindCurrentSpanStore?.();
    tracingChannel.unsubscribe(handlers);
  };
}

export function unsubscribeAll(
  unsubscribers: Array<() => void>,
): Array<() => void> {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }

  return [];
}
