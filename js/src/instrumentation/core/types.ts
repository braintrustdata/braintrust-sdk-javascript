/**
 * Standard event types for global hook-based instrumentation.
 *
 * These types retain the TracingChannel-compatible lifecycle.
 * For async functions (tracePromise):
 * - start: Called before the synchronous portion executes
 * - end: Called after the synchronous portion completes (promise returned)
 * - asyncStart: Called when the promise begins to settle
 * - asyncEnd: Called when the promise finishes settling (before user code continues)
 * - error: Called if the function throws or the promise rejects
 */

export type EventArguments = readonly unknown[];

export type ChannelSpanInfo = {
  name?: string;
  spanAttributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type SpanInfoCarrier<
  TSpanInfo extends ChannelSpanInfo = ChannelSpanInfo,
> = {
  span_info?: TSpanInfo;
};

/**
 * Base context object shared across all events in a trace.
 */
interface BaseContext {
  /**
   * Unique identifier for this trace.
   * Can be used to correlate start/end/error events.
   */
  traceId?: string;

  /**
   * Arbitrary data that can be attached by event handlers
   * and passed between start/end/error events.
   */
  [key: string]: unknown;
}

/**
 * Event emitted before the synchronous portion of a function executes.
 * This is where you should create spans and extract input data.
 */
export interface StartEvent<TInput = unknown> extends BaseContext {
  /**
   * Arguments passed to the function being traced.
   */
  arguments: TInput[];
}

export interface TypedStartEvent<
  TArguments extends EventArguments = unknown[],
> extends BaseContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments: [...TArguments, ...any[]];
}

export interface TypedEndEvent<
  TResult = unknown,
  TArguments extends EventArguments = unknown[],
> extends BaseContext {
  result: TResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments?: [...TArguments, ...any[]];
}

export interface TypedErrorEvent<
  TArguments extends EventArguments = unknown[],
> extends BaseContext {
  error: Error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments?: [...TArguments, ...any[]];
}

export type StartEventWith<
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = TypedStartEvent<TArguments> & TExtra;

export type EndEventWith<
  TResult = unknown,
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = TypedEndEvent<TResult, TArguments> & TExtra;

export type AsyncEndEventWith<
  TResult = unknown,
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = TypedEndEvent<TResult, TArguments> & TExtra;

export type ErrorEventWith<
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = TypedErrorEvent<TArguments> & TExtra;
