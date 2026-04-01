import iso from "../../isomorph";
import type { IsoChannelHandlers } from "../../isomorph";
import { isAsyncIterable, patchStreamIfNeeded } from "./stream-patcher";
import type { StartEvent } from "./types";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp } from "../../util";
import {
  buildStartSpanArgs,
  mergeInputMetadata,
} from "./channel-tracing-utils";

/**
 * Base class for creating instrumentation plugins.
 *
 * Plugins subscribe to diagnostics_channel events and convert them
 * into spans, logs, or other observability data.
 */
export abstract class BasePlugin {
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
   * @param channelName - The channel name to subscribe to
   * @param handlers - Event handlers
   */
  protected subscribe(channelName: string, handlers: IsoChannelHandlers): void {
    const channel = iso.newTracingChannel(channelName);
    channel.subscribe(handlers);
  }

  /**
   * Subscribe to a channel for async methods (non-streaming).
   * Creates a span and logs input/output/metrics.
   */
  protected subscribeToChannel(
    channelName: string,
    config: {
      name: string;
      type: string;
      extractInput: (args: any[]) => { input: any; metadata: any };
      extractOutput: (result: any, endEvent?: any) => any;
      extractMetadata?: (result: any, endEvent?: any) => any;
      extractMetrics: (
        result: any,
        startTime?: number,
        endEvent?: any,
      ) => Record<string, number>;
    },
  ): void {
    const channel = iso.newTracingChannel(channelName);

    const spans = new WeakMap<any, { span: Span; startTime: number }>();

    const handlers = {
      start: (event: StartEvent) => {
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
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
          console.error(`Error extracting input for ${channelName}:`, error);
        }
      },

      asyncEnd: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) {
          return;
        }

        const { span, startTime } = spanData;

        try {
          const output = config.extractOutput(event.result, event);
          const metrics = config.extractMetrics(event.result, startTime, event);
          const metadata = config.extractMetadata?.(event.result, event);

          span.log({
            output,
            ...(metadata !== undefined ? { metadata } : {}),
            metrics,
          });
        } catch (error) {
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
          console.error(`Error extracting output for ${channelName}:`, error);
        } finally {
          span.end();
          spans.delete(event);
        }
      },

      error: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) {
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

    channel.subscribe(handlers);

    // Store unsubscribe function
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }

  /**
   * Subscribe to a channel for async methods that may return streams.
   * Handles both streaming and non-streaming responses.
   */
  protected subscribeToStreamingChannel(
    channelName: string,
    config: {
      name: string;
      type: string;
      extractInput: (args: any[]) => { input: any; metadata: any };
      extractOutput: (result: any, endEvent?: any) => any;
      extractMetadata?: (result: any, endEvent?: any) => any;
      extractMetrics: (
        result: any,
        startTime?: number,
        endEvent?: any,
      ) => Record<string, number>;
      aggregateChunks?: (
        chunks: any[],
        result?: any,
        endEvent?: any,
      ) => {
        output: any;
        metrics: Record<string, number>;
        metadata?: any;
      };
    },
  ): void {
    const channel = iso.newTracingChannel(channelName);

    const spans = new WeakMap<any, { span: Span; startTime: number }>();

    const handlers = {
      start: (event: StartEvent) => {
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
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
          console.error(`Error extracting input for ${channelName}:`, error);
        }
      },

      asyncEnd: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) {
          return;
        }

        const { span, startTime } = spanData;

        // Check if result is a stream
        if (isAsyncIterable(event.result)) {
          let firstChunkTime: number | undefined;

          // Patch the stream to collect chunks
          patchStreamIfNeeded(event.result, {
            onChunk: () => {
              if (firstChunkTime === undefined) {
                firstChunkTime = getCurrentUnixTimestamp();
              }
            },
            onComplete: (chunks: any[]) => {
              try {
                let output: any;
                let metrics: Record<string, number>;
                let metadata: any;

                if (config.aggregateChunks) {
                  const aggregated = config.aggregateChunks(
                    chunks,
                    event.result,
                    event,
                  );
                  output = aggregated.output;
                  metrics = aggregated.metrics;
                  metadata = aggregated.metadata;
                } else {
                  output = config.extractOutput(chunks, event);
                  metrics = config.extractMetrics(chunks, startTime, event);
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
                // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
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
            const output = config.extractOutput(event.result, event);
            const metadata = config.extractMetadata
              ? config.extractMetadata(event.result, event)
              : undefined;
            const metrics = config.extractMetrics(
              event.result,
              startTime,
              event,
            );

            span.log({
              output,
              ...(metadata !== undefined ? { metadata } : {}),
              metrics,
            });
          } catch (error) {
            // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
            console.error(`Error extracting output for ${channelName}:`, error);
          } finally {
            span.end();
            spans.delete(event);
          }
        }
      },

      error: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) {
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

    channel.subscribe(handlers);

    // Store unsubscribe function
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }

  /**
   * Subscribe to a channel for sync methods that return event-based streams.
   * Used for methods like beta.chat.completions.stream() and responses.stream().
   */
  protected subscribeToSyncStreamChannel(
    channelName: string,
    config: {
      name: string;
      type: string;
      extractInput: (args: any[]) => { input: any; metadata: any };
      extractFromEvent?: (event: any) => {
        output?: any;
        metrics?: Record<string, number>;
        metadata?: any;
      };
    },
  ): void {
    const channel = iso.newTracingChannel(channelName);

    const spans = new WeakMap<any, { span: Span; startTime: number }>();

    const handlers = {
      start: (event: StartEvent) => {
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
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
          console.error(`Error extracting input for ${channelName}:`, error);
        }
      },

      end: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) {
          return;
        }

        const { span, startTime } = spanData;
        const stream = event.result;

        if (!stream || typeof stream.on !== "function") {
          // Not a stream, just end the span
          span.end();
          spans.delete(event);
          return;
        }

        let first = true;

        // Listen for stream events
        stream.on("chunk", (chunk: any) => {
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

        stream.on("chatCompletion", (completion: any) => {
          try {
            span.log({
              output: completion.choices,
            });
          } catch (error) {
            // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
            console.error(
              `Error extracting chatCompletion for ${channelName}:`,
              error,
            );
          }
        });

        stream.on("event", (streamEvent: any) => {
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
              // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
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

      error: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) {
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

    channel.subscribe(handlers);

    // Store unsubscribe function
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }
}
