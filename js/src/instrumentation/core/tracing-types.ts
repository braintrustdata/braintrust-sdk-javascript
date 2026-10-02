import type { ArgsOf, ExtraOf, ReturnOf } from "./channel-definitions";
import type {
  AsyncEndEventWith,
  EndEventWith,
  ErrorEventWith,
  StartEventWith,
} from "./types";

// These types describe tracing data, never a registration or invocation API.
export type AnyAsyncChannel = {
  __args?: readonly unknown[];
  __result?: unknown;
  __extra?: object;
  __chunk?: unknown;
  channelName: string;
};
export type AnySyncStreamChannel = AnyAsyncChannel;
export type ResultOf<T> = Awaited<ReturnOf<T>>;
export type StartOf<T extends AnyAsyncChannel> = StartEventWith<
  ArgsOf<T>,
  ExtraOf<T>
>;
export type AsyncEndOf<T extends AnyAsyncChannel> = AsyncEndEventWith<
  ResultOf<T>,
  ArgsOf<T>,
  ExtraOf<T>
>;
export type EndOf<T extends AnyAsyncChannel> = EndEventWith<
  ReturnOf<T>,
  ArgsOf<T>,
  ExtraOf<T>
>;
export type ErrorOf<T extends AnyAsyncChannel> = ErrorEventWith<
  ArgsOf<T>,
  ExtraOf<T>
>;
export type ChannelMessage<T extends AnyAsyncChannel> = StartOf<T> &
  Partial<{ result: ResultOf<T> }> &
  Partial<Pick<ErrorOf<T>, "error">>;
