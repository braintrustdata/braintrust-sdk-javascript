/** Per-call tracing data. These types do not define invocation hooks or event subscriptions. */

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
 * Per-call context passed to tracing callbacks.
 */
interface BaseContext {
  /**
   * Unique identifier for this trace.
   */
  traceId?: string;

  /**
   * Additional data used by tracing callbacks.
   */
  [key: string]: unknown;
}

/**
 * Input context for a tracing function.
 */
export interface StartEvent<TInput = unknown> extends BaseContext {
  /**
   * Arguments passed to the function being traced.
   */
  arguments: TInput[];
}

/**
 * Input context preserving the callable argument tuple.
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
