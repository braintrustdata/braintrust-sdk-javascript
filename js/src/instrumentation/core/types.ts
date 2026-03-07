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
export interface StartEvent<
  TArguments extends EventArguments = unknown[],
> extends BaseContext {
  /**
   * Arguments passed to the function being traced.
   */
  arguments: [...TArguments];
}

/**
 * Event emitted after the synchronous portion completes.
 * For async functions, this fires when the promise is returned (not settled).
 */
export interface EndEvent<
  TResult = unknown,
  TArguments extends EventArguments = unknown[],
> extends BaseContext {
  /**
   * The result of the synchronous portion.
   * For async functions, this is the promise (not the resolved value).
   */
  result: TResult;

  /**
   * Arguments passed to the function (also available in StartEvent).
   */
  arguments?: [...TArguments];
}

/**
 * Event emitted when a function throws or a promise rejects.
 */
export interface ErrorEvent<
  TArguments extends EventArguments = unknown[],
> extends BaseContext {
  /**
   * The error that was thrown or the rejection reason.
   */
  error: Error;

  /**
   * Arguments passed to the function (also available in StartEvent).
   */
  arguments?: [...TArguments];
}

/**
 * Event emitted when a promise begins to settle.
 * This fires after the synchronous portion and when the async continuation starts.
 */
export type AsyncStartEvent<TArguments extends EventArguments = unknown[]> =
  StartEvent<TArguments>;

/**
 * Event emitted when a promise finishes settling.
 * This fires BEFORE control returns to user code after await.
 * This is where you should extract output data and finalize spans.
 */
export type AsyncEndEvent<
  TResult = unknown,
  TArguments extends EventArguments = unknown[],
> = EndEvent<TResult, TArguments>;

export type StartEventWith<
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = StartEvent<TArguments> & TExtra;

export type EndEventWith<
  TResult = unknown,
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = EndEvent<TResult, TArguments> & TExtra;

export type AsyncEndEventWith<
  TResult = unknown,
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = AsyncEndEvent<TResult, TArguments> & TExtra;

export type ErrorEventWith<
  TArguments extends EventArguments = unknown[],
  TExtra extends object = Record<string, never>,
> = ErrorEvent<TArguments> & TExtra;

/**
 * Subscription handlers for a TracingChannel.
 *
 * Common usage pattern:
 * - Use start to create spans and extract input
 * - Use asyncEnd to extract output and finalize spans
 * - Use error to handle failures
 */
export interface ChannelHandlers<
  TArguments extends EventArguments = unknown[],
  TResult = unknown,
> {
  /**
   * Called before the synchronous portion of a function executes.
   * Use this to create spans and extract input data.
   */
  start?: (event: StartEvent<TArguments>) => void;

  /**
   * Called after the synchronous portion completes (promise returned).
   * Usually not needed for typical instrumentation.
   */
  end?: (event: EndEvent<TResult, TArguments>) => void;

  /**
   * Called when a promise begins to settle.
   * Usually not needed for typical instrumentation.
   */
  asyncStart?: (event: AsyncStartEvent<TArguments>) => void;

  /**
   * Called when a promise finishes settling, before user code continues.
   * Use this to extract output, patch streams, and finalize spans.
   */
  asyncEnd?: (event: AsyncEndEvent<TResult, TArguments>) => void;

  /**
   * Called when a function throws or promise rejects.
   * Use this to log errors and clean up spans.
   */
  error?: (event: ErrorEvent<TArguments>) => void;
}
