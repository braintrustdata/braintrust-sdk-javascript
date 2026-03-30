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

type ChannelTypeInfo<
  TArgs extends EventArguments,
  TResult,
  TExtra extends object = Record<string, unknown>,
  TChunk = never,
  TKind extends ChannelKind = "async",
> = {
  kind: TKind;
  __args?: TArgs;
  __result?: TResult;
  __extra?: TExtra;
  __chunk?: TChunk;
};

export type ChannelSpec<
  TArgs extends EventArguments,
  TResult,
  TExtra extends object = Record<string, unknown>,
  TChunk = never,
  TKind extends ChannelKind = "async",
> = ChannelTypeInfo<TArgs, TResult, TExtra, TChunk, TKind> & {
  channelName: string;
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

export type ArgsOf<TChannel> =
  TChannel extends ChannelTypeInfo<
    infer TArgs,
    unknown,
    object,
    unknown,
    ChannelKind
  >
    ? [...TArgs]
    : never;

export type ResultOf<TChannel> =
  TChannel extends ChannelTypeInfo<
    EventArguments,
    infer TResult,
    object,
    unknown,
    ChannelKind
  >
    ? TResult
    : never;

export type ExtraOf<TChannel> =
  TChannel extends ChannelTypeInfo<
    EventArguments,
    unknown,
    infer TExtra extends object,
    unknown,
    ChannelKind
  >
    ? TExtra
    : never;

export type ChunkOf<TChannel> =
  TChannel extends ChannelTypeInfo<
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
    tracePromise<TReturn extends PromiseLike<ResultOf<TSpec>>>(
      fn: () => TReturn,
      context: StartOf<TSpec>,
    ): TReturn;
  };

export type TypedSyncStreamChannel<TSpec extends AnySyncStreamChannelSpec> =
  BaseTypedChannel<TSpec> & {
    traceSync<TResult extends ResultOf<TSpec>>(
      fn: () => TResult,
      context: StartOf<TSpec>,
    ): TResult;
  };

export type AnyAsyncChannel = TypedAsyncChannel<AnyAsyncChannelSpec>;
export type AnySyncStreamChannel =
  TypedSyncStreamChannel<AnySyncStreamChannelSpec>;

type ChannelSpecMap = Record<string, AnyChannelSpec>;

export function channel<
  TArgs extends EventArguments,
  TResult,
  TExtra extends object = Record<string, unknown>,
  TChunk = never,
>(spec: {
  channelName: string;
  kind: "async";
}): ChannelSpec<TArgs, TResult, TExtra, TChunk, "async">;
export function channel<
  TArgs extends EventArguments,
  TResult,
  TExtra extends object = Record<string, unknown>,
  TChunk = never,
>(spec: {
  channelName: string;
  kind: "sync-stream";
}): ChannelSpec<TArgs, TResult, TExtra, TChunk, "sync-stream">;
export function channel(spec: {
  channelName: string;
  kind: ChannelKind;
}): AnyChannelSpec {
  return spec as AnyChannelSpec;
}

type MaterializedChannel<T extends AnyChannelSpec> = T["kind"] extends "async"
  ? TypedAsyncChannel<
      ChannelSpec<ArgsOf<T>, ResultOf<T>, ExtraOf<T>, ChunkOf<T>, "async">
    >
  : TypedSyncStreamChannel<
      ChannelSpec<ArgsOf<T>, ResultOf<T>, ExtraOf<T>, ChunkOf<T>, "sync-stream">
    >;

export function defineChannels<T extends ChannelSpecMap>(
  pkg: string,
  channels: T,
): {
  [K in keyof T]: MaterializedChannel<T[K]>;
} {
  return Object.fromEntries(
    Object.entries(channels).map(([key, spec]) => {
      const fullChannelName = `orchestrion:${pkg}:${spec.channelName}`;
      if (spec.kind === "async") {
        const asyncSpec = spec as ChannelSpec<
          ArgsOf<typeof spec>,
          ResultOf<typeof spec>,
          ExtraOf<typeof spec>,
          ChunkOf<typeof spec>,
          "async"
        >;
        const tracingChannel = () =>
          iso.newTracingChannel<ChannelMessage<AnyAsyncChannelSpec>>(
            fullChannelName,
          );
        return [
          key,
          {
            ...asyncSpec,
            tracingChannel,
            tracePromise: <TReturn extends Promise<ResultOf<typeof asyncSpec>>>(
              fn: () => TReturn,
              context: StartOf<AnyAsyncChannelSpec>,
            ) =>
              tracingChannel().tracePromise(
                fn,
                // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                context as ChannelMessage<AnyAsyncChannelSpec>,
              ) as TReturn,
          } as AnyAsyncChannel,
        ];
      }

      const syncSpec = spec as ChannelSpec<
        ArgsOf<typeof spec>,
        ResultOf<typeof spec>,
        ExtraOf<typeof spec>,
        ChunkOf<typeof spec>,
        "sync-stream"
      >;
      const tracingChannel = () =>
        iso.newTracingChannel<ChannelMessage<AnySyncStreamChannelSpec>>(
          fullChannelName,
        );
      return [
        key,
        {
          ...syncSpec,
          tracingChannel,
          traceSync: <TResult>(
            fn: () => TResult,
            context: StartOf<AnySyncStreamChannelSpec>,
          ) =>
            tracingChannel().traceSync(
              fn,
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
              context as ChannelMessage<AnySyncStreamChannelSpec>,
            ),
        } as AnySyncStreamChannel,
      ];
    }),
  ) as {
    [K in keyof T]: MaterializedChannel<T[K]>;
  };
}
