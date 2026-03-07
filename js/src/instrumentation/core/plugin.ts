import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import { isAsyncIterable, patchStreamIfNeeded } from "./stream-patcher";
import type {
  AnyAsyncChannel,
  ArgsOf,
  ChannelMap,
  ChannelMessage,
  ChunkOf,
  ExtraOf,
  ResultOf,
} from "./channel-spec";
import type {
  AsyncEndEventWith,
  ErrorEventWith,
  EventArguments,
  StartEvent,
  StartEventWith,
} from "./types";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp, isObject, mergeDicts } from "../../util";

type ChannelConfig = {
  name: string;
  type: string;
};

type ChannelSpanInfo = {
  name?: string;
  spanAttributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type ChannelEventExtras = {
  span_info?: ChannelSpanInfo;
};

type ChannelLifecycleEvent<
  TArguments extends EventArguments,
  TResult,
  TExtra extends object = Record<string, never>,
> = StartEventWith<TArguments, TExtra & ChannelEventExtras> &
  Partial<Pick<AsyncEndEventWith<TResult, TArguments>, "result">> &
  Partial<Pick<ErrorEventWith<TArguments>, "error">>;

type ChannelState = {
  span: Span;
  startTime: number;
};

type ExtractedInput<TInput = unknown, TMetadata = unknown> = {
  input: TInput;
  metadata: TMetadata;
};

type NonStreamingResult<TResult> = Exclude<TResult, AsyncIterable<unknown>>;

type ChannelSubscriptionConfig<
  TArguments extends EventArguments,
  TResult,
  TExtra extends object = Record<string, never>,
  TInput = unknown,
  TMetadata = unknown,
  TOutput = unknown,
  TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
> = ChannelConfig & {
  extractInput: (args: [...TArguments]) => ExtractedInput<TInput, TMetadata>;
  extractOutput: (
    result: TResult,
    endEvent?: AsyncEndEventWith<
      TResult,
      TArguments,
      TExtra & ChannelEventExtras
    >,
  ) => TOutput;
  extractMetadata?: (
    result: TResult,
    endEvent?: AsyncEndEventWith<
      TResult,
      TArguments,
      TExtra & ChannelEventExtras
    >,
  ) => TOutputMetadata | undefined;
  extractMetrics: (
    result: TResult,
    startTime?: number,
    endEvent?: AsyncEndEventWith<
      TResult,
      TArguments,
      TExtra & ChannelEventExtras
    >,
  ) => Record<string, number>;
};

type StreamingChannelSubscriptionConfig<
  TArguments extends EventArguments,
  TResult,
  TChunk = unknown,
  TExtra extends object = Record<string, never>,
  TInput = unknown,
  TMetadata = unknown,
  TOutput = unknown,
  TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
  THasAggregate extends boolean = false,
  TStreamOutput = TOutput,
  TStreamOutputMetadata extends Record<string, unknown> = TOutputMetadata,
> = ChannelConfig & {
  extractInput: (args: [...TArguments]) => ExtractedInput<TInput, TMetadata>;
  extractOutput: (
    result: THasAggregate extends true ? NonStreamingResult<TResult> : TResult,
    endEvent?: AsyncEndEventWith<
      TResult,
      TArguments,
      TExtra & ChannelEventExtras
    >,
  ) => TOutput;
  extractMetadata?: (
    result: THasAggregate extends true ? NonStreamingResult<TResult> : TResult,
    endEvent?: AsyncEndEventWith<
      TResult,
      TArguments,
      TExtra & ChannelEventExtras
    >,
  ) => TOutputMetadata | undefined;
  extractMetrics: (
    result: THasAggregate extends true ? NonStreamingResult<TResult> : TResult,
    startTime?: number,
    endEvent?: AsyncEndEventWith<
      TResult,
      TArguments,
      TExtra & ChannelEventExtras
    >,
  ) => Record<string, number>;
} & (THasAggregate extends true
    ? {
        aggregateChunks: (
          chunks: TChunk[],
          result?: TResult,
          endEvent?: AsyncEndEventWith<
            TResult,
            TArguments,
            TExtra & ChannelEventExtras
          >,
          startTime?: number,
        ) => {
          output: TStreamOutput;
          metrics: Record<string, number>;
          metadata?: TStreamOutputMetadata;
        };
      }
    : {
        aggregateChunks?: undefined;
      });

type SyncStreamChannelSubscriptionConfig<
  TArguments extends EventArguments,
  _TResult,
  TStreamEvent = unknown,
  _TExtra extends object = Record<string, never>,
  TInput = unknown,
  TMetadata = unknown,
  TOutput = unknown,
  TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
> = ChannelConfig & {
  extractInput: (args: [...TArguments]) => ExtractedInput<TInput, TMetadata>;
  extractFromEvent?: (event: TStreamEvent) => {
    output?: TOutput;
    metrics?: Record<string, number>;
    metadata?: TOutputMetadata;
  };
};

function getChannelSpanInfo(
  event: StartEvent<EventArguments> & Partial<ChannelEventExtras>,
): ChannelSpanInfo | undefined {
  const fromContext = (event as Record<string, unknown>).span_info;
  if (isObject(fromContext)) {
    return fromContext as ChannelSpanInfo;
  }

  const firstArg = event.arguments?.[0];
  if (
    isObject(firstArg) &&
    isObject((firstArg as Record<string, unknown>).span_info)
  ) {
    return (firstArg as Record<string, unknown>).span_info as ChannelSpanInfo;
  }

  return undefined;
}

/**
 * Resolves span start config for a channel event by combining static channel
 * config (`name`, `type`) with per-call overrides from optional `span_info`.
 */
function buildStartSpanArgs(
  config: ChannelConfig,
  event: StartEvent<EventArguments> & Partial<ChannelEventExtras>,
): {
  name: string;
  spanAttributes: Record<string, unknown>;
  spanInfoMetadata: Record<string, unknown> | undefined;
} {
  const spanInfo = getChannelSpanInfo(event);
  const spanAttributes: Record<string, unknown> = {
    type: config.type,
  };

  if (isObject(spanInfo?.spanAttributes)) {
    mergeDicts(spanAttributes, spanInfo.spanAttributes);
  }

  return {
    name:
      typeof spanInfo?.name === "string" && spanInfo.name
        ? spanInfo.name
        : config.name,
    spanAttributes,
    spanInfoMetadata: isObject(spanInfo?.metadata)
      ? spanInfo.metadata
      : undefined,
  };
}

function mergeInputMetadata(
  metadata: unknown,
  spanInfoMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!spanInfoMetadata) {
    return isObject(metadata)
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (metadata as Record<string, unknown>)
      : undefined;
  }

  const mergedMetadata: Record<string, unknown> = {};
  mergeDicts(mergedMetadata, spanInfoMetadata);

  if (isObject(metadata)) {
    mergeDicts(mergedMetadata, metadata as Record<string, unknown>);
  }

  return mergedMetadata;
}

function hasResult<
  TArguments extends EventArguments,
  TResult,
  TExtra extends object,
>(
  event: ChannelLifecycleEvent<TArguments, TResult, TExtra>,
): event is ChannelLifecycleEvent<TArguments, TResult, TExtra> & {
  result: TResult;
} {
  return "result" in event;
}

function hasError<
  TArguments extends EventArguments,
  TResult,
  TExtra extends object,
>(
  event: ChannelLifecycleEvent<TArguments, TResult, TExtra>,
): event is ChannelLifecycleEvent<TArguments, TResult, TExtra> & {
  error: Error;
} {
  return "error" in event;
}

function isStreamingResult<TResult>(
  result: TResult,
): result is Extract<TResult, AsyncIterable<unknown>> {
  return isAsyncIterable(result);
}

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
  return isObject(value) && typeof value.on === "function";
}

function hasChoices(value: unknown): value is { choices?: unknown } {
  return isObject(value) && "choices" in value;
}

/**
 * Base class for creating instrumentation plugins.
 *
 * Plugins subscribe to diagnostics_channel events and convert them
 * into spans, logs, or other observability data.
 */
export abstract class BasePlugin<TChannels extends ChannelMap = ChannelMap> {
  protected enabled = false;
  protected unsubscribers: Array<() => void> = [];

  /**
   * Enables the plugin. Must be called before the plugin will receive events.
   */
  enable(): void {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    this.onEnable();
  }

  /**
   * Disables the plugin. After this, the plugin will no longer receive events.
   */
  disable(): void {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    this.onDisable();
  }

  /**
   * Called when the plugin is enabled.
   * Override this to set up subscriptions.
   */
  protected abstract onEnable(): void;

  /**
   * Called when the plugin is disabled.
   * Override this to clean up subscriptions.
   */
  protected abstract onDisable(): void;

  /**
   * Helper to subscribe to a channel with raw handlers.
   *
   * @param channel - The typed channel to subscribe to
   * @param handlers - Event handlers
   */
  protected subscribe<TChannel extends TChannels[keyof TChannels]>(
    channel: TChannel,
    handlers: IsoChannelHandlers<ChannelMessage<TChannel>>,
  ): void {
    const tracingChannel = channel.tracingChannel() as IsoTracingChannel<
      ChannelMessage<TChannel>
    >;
    tracingChannel.subscribe(handlers);
  }

  /**
   * Subscribe to a channel for async methods (non-streaming).
   * Creates a span and logs input/output/metrics.
   */
  protected subscribeToChannel<
    TChannel extends Extract<TChannels[keyof TChannels], AnyAsyncChannel>,
    TInput = unknown,
    TMetadata = unknown,
    TOutput = unknown,
    TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    channel: TChannel,
    config: ChannelSubscriptionConfig<
      ArgsOf<TChannel>,
      ResultOf<TChannel>,
      ExtraOf<TChannel>,
      TInput,
      TMetadata,
      TOutput,
      TOutputMetadata
    >,
  ): void {
    type TArguments = ArgsOf<TChannel>;
    type TResult = ResultOf<TChannel>;
    type TExtra = ExtraOf<TChannel>;
    type TEvent = ChannelLifecycleEvent<TArguments, TResult, TExtra>;
    const channelName = channel.fullName;
    const tracingChannel =
      channel.tracingChannel() as IsoTracingChannel<TEvent>;

    const spans = new WeakMap<object, ChannelState>();

    const handlers: IsoChannelHandlers<TEvent> = {
      start: (event) => {
        const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
          config,
          event,
        );
        const span = startSpan({
          name,
          spanAttributes,
        });

        const startTime = getCurrentUnixTimestamp();
        spans.set(event, { span, startTime });

        try {
          const { input, metadata } = config.extractInput(event.arguments);
          span.log({
            input,
            metadata: mergeInputMetadata(metadata, spanInfoMetadata),
          });
        } catch (error) {
          console.error(`Error extracting input for ${channelName}:`, error);
        }
      },

      asyncEnd: (event) => {
        const spanData = spans.get(event);
        if (!spanData || !hasResult(event)) {
          return;
        }

        const { span, startTime } = spanData;
        const endEvent = event;
        const result = endEvent.result;

        try {
          const output = config.extractOutput(result, endEvent);
          const metrics = config.extractMetrics(result, startTime, endEvent);
          const metadata = config.extractMetadata?.(result, endEvent);

          span.log({
            output,
            ...(metadata !== undefined ? { metadata } : {}),
            metrics,
          });
        } catch (error) {
          console.error(`Error extracting output for ${channelName}:`, error);
        } finally {
          span.end();
          spans.delete(event);
        }
      },

      error: (event) => {
        const spanData = spans.get(event);
        if (!spanData || !hasError(event)) {
          return;
        }

        const { span } = spanData;

        span.log({
          error: event.error.message,
        });
        span.end();
        spans.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);

    // Store unsubscribe function
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  /**
   * Subscribe to a channel for async methods that may return streams.
   * Handles both streaming and non-streaming responses.
   */
  protected subscribeToStreamingChannel<
    TChannel extends Extract<TChannels[keyof TChannels], AnyAsyncChannel>,
    TInput = unknown,
    TMetadata = unknown,
    TOutput = unknown,
    TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
    TStreamOutput = TOutput,
    TStreamOutputMetadata extends Record<string, unknown> = TOutputMetadata,
  >(
    channel: TChannel,
    config: StreamingChannelSubscriptionConfig<
      ArgsOf<TChannel>,
      ResultOf<TChannel>,
      ChunkOf<TChannel>,
      ExtraOf<TChannel>,
      TInput,
      TMetadata,
      TOutput,
      TOutputMetadata,
      true,
      TStreamOutput,
      TStreamOutputMetadata
    >,
  ): void;
  protected subscribeToStreamingChannel<
    TChannel extends Extract<TChannels[keyof TChannels], AnyAsyncChannel>,
    TInput = unknown,
    TMetadata = unknown,
    TOutput = unknown,
    TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    channel: TChannel,
    config: StreamingChannelSubscriptionConfig<
      ArgsOf<TChannel>,
      ResultOf<TChannel>,
      ChunkOf<TChannel>,
      ExtraOf<TChannel>,
      TInput,
      TMetadata,
      TOutput,
      TOutputMetadata,
      false
    >,
  ): void;
  protected subscribeToStreamingChannel<
    TChannel extends Extract<TChannels[keyof TChannels], AnyAsyncChannel>,
    TInput = unknown,
    TMetadata = unknown,
    TOutput = unknown,
    TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
    TStreamOutput = TOutput,
    TStreamOutputMetadata extends Record<string, unknown> = TOutputMetadata,
  >(
    channel: TChannel,
    config: StreamingChannelSubscriptionConfig<
      ArgsOf<TChannel>,
      ResultOf<TChannel>,
      ChunkOf<TChannel>,
      ExtraOf<TChannel>,
      TInput,
      TMetadata,
      TOutput,
      TOutputMetadata,
      boolean,
      TStreamOutput,
      TStreamOutputMetadata
    >,
  ): void {
    type TArguments = ArgsOf<TChannel>;
    type TResult = ResultOf<TChannel>;
    type TChunk = ChunkOf<TChannel>;
    type TExtra = ExtraOf<TChannel>;
    type TEvent = ChannelLifecycleEvent<TArguments, TResult, TExtra>;
    const channelName = channel.fullName;
    const tracingChannel =
      channel.tracingChannel() as IsoTracingChannel<TEvent>;

    const spans = new WeakMap<object, ChannelState>();

    const handlers: IsoChannelHandlers<TEvent> = {
      start: (event) => {
        const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
          config,
          event,
        );
        const span = startSpan({
          name,
          spanAttributes,
        });

        const startTime = getCurrentUnixTimestamp();
        spans.set(event, { span, startTime });

        try {
          const { input, metadata } = config.extractInput(event.arguments);
          span.log({
            input,
            metadata: mergeInputMetadata(metadata, spanInfoMetadata),
          });
        } catch (error) {
          console.error(`Error extracting input for ${channelName}:`, error);
        }
      },

      asyncEnd: (event) => {
        const spanData = spans.get(event);
        if (!spanData || !hasResult(event)) {
          return;
        }

        const { span, startTime } = spanData;
        const endEvent = event;
        const result = endEvent.result;

        // Check if result is a stream
        if (isStreamingResult(result)) {
          let firstChunkTime: number | undefined;

          // Patch the stream to collect chunks
          patchStreamIfNeeded<TChunk>(result, {
            onChunk: () => {
              if (firstChunkTime === undefined) {
                firstChunkTime = getCurrentUnixTimestamp();
              }
            },
            onComplete: (chunks: TChunk[]) => {
              try {
                let output: TOutput | TStreamOutput;
                let metrics: Record<string, number>;
                let metadata:
                  | TOutputMetadata
                  | TStreamOutputMetadata
                  | undefined;

                if (config.aggregateChunks) {
                  const aggregated = config.aggregateChunks(
                    chunks,
                    result,
                    endEvent,
                    startTime,
                  );
                  output = aggregated.output;
                  metrics = aggregated.metrics;
                  metadata = aggregated.metadata;
                } else {
                  output = config.extractOutput(
                    // Without an aggregateChunks handler, fall back to passing the
                    // collected stream chunks to the extractor callbacks.
                    chunks as TResult,
                    endEvent,
                  );
                  metrics = config.extractMetrics(
                    chunks as TResult,
                    startTime,
                    endEvent,
                  );
                }

                // Add time_to_first_token if not already present
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
              }
            },
            onError: (error: Error) => {
              span.log({
                error: error.message,
              });
              span.end();
            },
          });

          // Don't delete the span from the map yet - it will be ended by the stream
        } else {
          // Non-streaming response
          try {
            const nonStreamingResult = result;
            const output = config.extractOutput(nonStreamingResult, endEvent);
            const metadata = config.extractMetadata
              ? config.extractMetadata(nonStreamingResult, endEvent)
              : undefined;
            const metrics = config.extractMetrics(
              nonStreamingResult,
              startTime,
              endEvent,
            );

            span.log({
              output,
              ...(metadata !== undefined ? { metadata } : {}),
              metrics,
            });
          } catch (error) {
            console.error(`Error extracting output for ${channelName}:`, error);
          } finally {
            span.end();
            spans.delete(event);
          }
        }
      },

      error: (event) => {
        const spanData = spans.get(event);
        if (!spanData || !hasError(event)) {
          return;
        }

        const { span } = spanData;

        span.log({
          error: event.error.message,
        });
        span.end();
        spans.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);

    // Store unsubscribe function
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  /**
   * Subscribe to a channel for sync methods that return event-based streams.
   * Used for methods like beta.chat.completions.stream() and responses.stream().
   */
  protected subscribeToSyncStreamChannel<
    TChannel extends Exclude<TChannels[keyof TChannels], AnyAsyncChannel>,
    TInput = unknown,
    TMetadata = unknown,
    TOutput = unknown,
    TOutputMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    channel: TChannel,
    config: SyncStreamChannelSubscriptionConfig<
      ArgsOf<TChannel>,
      ResultOf<TChannel>,
      ChunkOf<TChannel>,
      ExtraOf<TChannel>,
      TInput,
      TMetadata,
      TOutput,
      TOutputMetadata
    >,
  ): void {
    type TArguments = ArgsOf<TChannel>;
    type TResult = ResultOf<TChannel>;
    type TStreamEvent = ChunkOf<TChannel>;
    type TExtra = ExtraOf<TChannel>;
    type TEvent = ChannelLifecycleEvent<TArguments, TResult, TExtra>;
    const channelName = channel.fullName;
    const tracingChannel =
      channel.tracingChannel() as IsoTracingChannel<TEvent>;

    const spans = new WeakMap<object, ChannelState>();

    const handlers: IsoChannelHandlers<TEvent> = {
      start: (event) => {
        const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
          config,
          event,
        );
        const span = startSpan({
          name,
          spanAttributes,
        });

        const startTime = getCurrentUnixTimestamp();
        spans.set(event, { span, startTime });

        try {
          const { input, metadata } = config.extractInput(event.arguments);
          span.log({
            input,
            metadata: mergeInputMetadata(metadata, spanInfoMetadata),
          });
        } catch (error) {
          console.error(`Error extracting input for ${channelName}:`, error);
        }
      },

      end: (event) => {
        const spanData = spans.get(event);
        if (!spanData || !hasResult(event)) {
          return;
        }

        const { span, startTime } = spanData;
        const endEvent = event;
        const stream = endEvent.result;

        if (!isSyncStreamLike<TStreamEvent>(stream)) {
          // Not a stream, just end the span
          span.end();
          spans.delete(event);
          return;
        }

        let first = true;

        // Listen for stream events
        stream.on("chunk", (_chunk: unknown) => {
          if (first) {
            const now = getCurrentUnixTimestamp();
            span.log({
              metrics: {
                time_to_first_token: now - startTime,
              },
            });
            first = false;
          }
        });

        stream.on("chatCompletion", (completion: unknown) => {
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
          if (config.extractFromEvent) {
            try {
              if (first) {
                const now = getCurrentUnixTimestamp();
                span.log({
                  metrics: {
                    time_to_first_token: now - startTime,
                  },
                });
                first = false;
              }

              const extracted = config.extractFromEvent(streamEvent);
              if (extracted && Object.keys(extracted).length > 0) {
                span.log(extracted);
              }
            } catch (error) {
              console.error(
                `Error extracting event for ${channelName}:`,
                error,
              );
            }
          }
        });

        stream.on("end", () => {
          span.end();
          spans.delete(event);
        });

        // Don't delete the span from the map - it will be deleted when the stream ends
      },

      error: (event) => {
        const spanData = spans.get(event);
        if (!spanData || !hasError(event)) {
          return;
        }

        const { span } = spanData;

        span.log({
          error: event.error.message,
        });
        span.end();
        spans.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);

    // Store unsubscribe function
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }
}
