/**
 * Standard event types for diagnostics_channel-based instrumentation.
 *
 * These types follow the TracingChannel pattern from Node.js.
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
export interface BaseContext {
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

/**
 * Event emitted after the synchronous portion completes.
 * For async functions, this fires when the promise is returned (not settled).
 */
export interface EndEvent<TResult = unknown> extends BaseContext {
  /**
   * The result of the synchronous portion.
   * For async functions, this is the promise (not the resolved value).
   */
  result: TResult;

  /**
   * Arguments passed to the function (also available in StartEvent).
   */
  arguments?: unknown[];
}

/**
 * Event emitted when a function throws or a promise rejects.
 */
export interface ErrorEvent extends BaseContext {
  /**
   * The error that was thrown or the rejection reason.
   */
  error: Error;

  /**
   * Arguments passed to the function (also available in StartEvent).
   */
  arguments?: unknown[];
}

/**
 * Event emitted when a promise begins to settle.
 * This fires after the synchronous portion and when the async continuation starts.
 */
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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AsyncStartEvent<TInput = unknown> extends StartEvent<TInput> {}

/**
 * Event emitted when a promise finishes settling.
 * This fires BEFORE control returns to user code after await.
 * This is where you should extract output data and finalize spans.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AsyncEndEvent<TResult = unknown> extends EndEvent<TResult> {}

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

/**
 * Subscription handlers for a TracingChannel.
 *
 * Common usage pattern:
 * - Use start to create spans and extract input
 * - Use asyncEnd to extract output and finalize spans
 * - Use error to handle failures
 */
export interface ChannelHandlers<TInput = unknown, TResult = unknown> {
  /**
   * Called before the synchronous portion of a function executes.
   * Use this to create spans and extract input data.
   */
  start?: (event: StartEvent<TInput>) => void;

  /**
   * Called after the synchronous portion completes (promise returned).
   * Usually not needed for typical instrumentation.
   */
  end?: (event: EndEvent<TResult>) => void;

  /**
   * Called when a promise begins to settle.
   * Usually not needed for typical instrumentation.
   */
  asyncStart?: (event: AsyncStartEvent<TInput>) => void;

  /**
   * Called when a promise finishes settling, before user code continues.
   * Use this to extract output, patch streams, and finalize spans.
   */
  asyncEnd?: (event: AsyncEndEvent<TResult>) => void;

  /**
   * Called when a function throws or promise rejects.
   * Use this to log errors and clean up spans.
   */
  error?: (event: ErrorEvent) => void;
}
