import iso from "../../isomorph";
import type { IsoTracingChannel } from "../../isomorph";
import type {
  AsyncEndEventWith,
  EndEventWith,
  ErrorEventWith,
  EventArguments,
  StartEventWith,
} from "./types";

export type ChannelKind = "async" | "sync-stream";

export type ChannelSpec<
  TArgs extends EventArguments,
  TResult,
  TExtra extends object = Record<string, never>,
  TChunk = never,
  TKind extends ChannelKind = "async",
> = {
  name: string;
  fullName: string;
  kind: TKind;
  __args?: TArgs;
  __result?: TResult;
  __extra?: TExtra;
  __chunk?: TChunk;
};

type AnyAsyncChannelSpec = ChannelSpec<
  EventArguments,
  unknown,
  object,
  unknown,
  "async"
>;

type AnySyncStreamChannelSpec = ChannelSpec<
  EventArguments,
  unknown,
  object,
  unknown,
  "sync-stream"
>;

type AnyChannelSpec = AnyAsyncChannelSpec | AnySyncStreamChannelSpec;
type GenericChannelSpec = ChannelSpec<
  EventArguments,
  unknown,
  object,
  unknown,
  ChannelKind
>;

export type AnyAsyncChannelSpecType = AnyAsyncChannelSpec;
export type AnySyncStreamChannelSpecType = AnySyncStreamChannelSpec;

export type ArgsOf<TChannel> =
  TChannel extends ChannelSpec<
    infer TArgs,
    unknown,
    object,
    unknown,
    ChannelKind
  >
    ? [...TArgs]
    : never;

export type ResultOf<TChannel> =
  TChannel extends ChannelSpec<
    EventArguments,
    infer TResult,
    object,
    unknown,
    ChannelKind
  >
    ? TResult
    : never;

export type ExtraOf<TChannel> =
  TChannel extends ChannelSpec<
    EventArguments,
    unknown,
    infer TExtra extends object,
    unknown,
    ChannelKind
  >
    ? TExtra
    : never;

export type ChunkOf<TChannel> =
  TChannel extends ChannelSpec<
    EventArguments,
    unknown,
    object,
    infer TChunk,
    ChannelKind
  >
    ? TChunk
    : never;

export type StartOf<TChannel extends AnyChannelSpec> = StartEventWith<
  ArgsOf<TChannel>,
  ExtraOf<TChannel>
>;

export type AsyncEndOf<TChannel extends AnyChannelSpec> = AsyncEndEventWith<
  ResultOf<TChannel>,
  ArgsOf<TChannel>,
  ExtraOf<TChannel>
>;

export type EndOf<TChannel extends AnyChannelSpec> = EndEventWith<
  ResultOf<TChannel>,
  ArgsOf<TChannel>,
  ExtraOf<TChannel>
>;

export type ErrorOf<TChannel extends AnyChannelSpec> = ErrorEventWith<
  ArgsOf<TChannel>,
  ExtraOf<TChannel>
>;

export type ChannelMessage<TChannel extends AnyChannelSpec> =
  StartOf<TChannel> &
    Partial<{ result: ResultOf<TChannel> }> &
    Partial<Pick<ErrorOf<TChannel>, "error">>;

type BaseTypedChannel<TSpec extends AnyChannelSpec> = TSpec & {
  tracingChannel(): IsoTracingChannel<ChannelMessage<TSpec>>;
};

export type TypedAsyncChannel<TSpec extends AnyAsyncChannelSpec> =
  BaseTypedChannel<TSpec> & {
    tracePromise<TResult extends ResultOf<TSpec>>(
      fn: () => Promise<TResult>,
      context: StartOf<TSpec>,
    ): Promise<TResult>;
  };

export type TypedSyncStreamChannel<TSpec extends AnySyncStreamChannelSpec> =
  BaseTypedChannel<TSpec> & {
    traceSync<TResult extends ResultOf<TSpec>>(
      fn: () => TResult,
      context: StartOf<TSpec>,
    ): TResult;
  };

export type AnyTypedChannel =
  | TypedAsyncChannel<AnyAsyncChannelSpec>
  | TypedSyncStreamChannel<AnySyncStreamChannelSpec>;

export type AnyAsyncChannel = TypedAsyncChannel<AnyAsyncChannelSpec>;
export type AnySyncStreamChannel =
  TypedSyncStreamChannel<AnySyncStreamChannelSpec>;

export type TypedChannel<TSpec extends GenericChannelSpec = AnyChannelSpec> =
  TSpec extends ChannelSpec<EventArguments, unknown, object, unknown, "async">
    ? TypedAsyncChannel<TSpec>
    : TSpec extends ChannelSpec<
          EventArguments,
          unknown,
          object,
          unknown,
          "sync-stream"
        >
      ? TypedSyncStreamChannel<TSpec>
      : never;

export type ChannelMap = Record<string, AnyTypedChannel>;

export function channel<
  TArgs extends EventArguments,
  TResult,
  TExtra extends object = Record<string, never>,
  TChunk = never,
>(spec: {
  name: string;
  fullName: string;
  kind: "async";
}): TypedAsyncChannel<ChannelSpec<TArgs, TResult, TExtra, TChunk, "async">>;
export function channel<
  TArgs extends EventArguments,
  TResult,
  TExtra extends object = Record<string, never>,
  TChunk = never,
>(spec: {
  name: string;
  fullName: string;
  kind: "sync-stream";
}): TypedSyncStreamChannel<
  ChannelSpec<TArgs, TResult, TExtra, TChunk, "sync-stream">
>;
export function channel(spec: {
  name: string;
  fullName: string;
  kind: ChannelKind;
}): AnyTypedChannel {
  if (spec.kind === "async") {
    const tracingChannel = () =>
      iso.newTracingChannel<ChannelMessage<AnyAsyncChannelSpec>>(spec.fullName);
    return {
      ...spec,
      tracingChannel,
      tracePromise: <TResult>(
        fn: () => Promise<TResult>,
        context: StartOf<AnyAsyncChannelSpec>,
      ) =>
        tracingChannel().tracePromise(
          fn,
          context as ChannelMessage<AnyAsyncChannelSpec>,
        ),
    } as AnyAsyncChannel;
  }

  const tracingChannel = () =>
    iso.newTracingChannel<ChannelMessage<AnySyncStreamChannelSpec>>(
      spec.fullName,
    );
  return {
    ...spec,
    tracingChannel,
    traceSync: <TResult>(
      fn: () => TResult,
      context: StartOf<AnySyncStreamChannelSpec>,
    ) =>
      tracingChannel().traceSync(
        fn,
        context as ChannelMessage<AnySyncStreamChannelSpec>,
      ),
  } as AnySyncStreamChannel;
}

export function defineChannels<T extends ChannelMap>(channels: T): T {
  return channels;
}
