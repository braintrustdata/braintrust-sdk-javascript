import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";

type ChannelSpec<
  TArgs extends readonly unknown[],
  TResult,
  TExtra extends object,
  TChunk,
> = {
  channelName: string;
  __args?: TArgs;
  __result?: TResult;
  __extra?: TExtra;
  __chunk?: TChunk;
};
type AnySpec = ChannelSpec<readonly unknown[], unknown, object, unknown>;
export type ArgsOf<T> = T extends {
  __args?: infer A extends readonly unknown[];
}
  ? [...A]
  : never;
export type ReturnOf<T> = T extends { __result?: infer R } ? R : never;
export type ExtraOf<T> = T extends { __extra?: infer E extends object }
  ? E
  : never;
export type ChunkOf<T> = T extends { __chunk?: infer R } ? R : never;
export type InvocationAdditionalOf<T> = ExtraOf<T> & { moduleVersion?: string };
export type Interceptor<T extends AnySpec> = (
  target: (this: unknown, ...args: ArgsOf<T>) => ReturnOf<T>,
  receiver: unknown,
  args: ArgsOf<T>,
  additional: InvocationAdditionalOf<T>,
) => ReturnOf<T>;
export type InvocationChannel<T extends AnySpec> = T & {
  intercept(interceptor: Interceptor<T>): () => void;
  invoke<F extends (this: any, ...args: any[]) => ReturnOf<T>>(
    target: F,
    receiver: ThisParameterType<F>,
    args: Parameters<F> | ArgsOf<T>,
    additional: InvocationAdditionalOf<T>,
  ): ReturnType<F>;
};

/** Describe a callable. Additional data is opaque to the wrapping runtime. */
export function channel<
  TArgs extends readonly unknown[],
  TResult,
  TExtra extends object = Record<string, unknown>,
  TChunk = never,
>(spec: { channelName: string }): ChannelSpec<TArgs, TResult, TExtra, TChunk> {
  return spec;
}

/** Define invocation hooks without initializing the SDK or enabling tracing. */
export function defineInterceptor<T extends Record<string, AnySpec>>(
  pkg: string,
  definitions: T,
): { [K in keyof T]: InvocationChannel<T[K]> } {
  return Object.fromEntries(
    Object.entries(definitions).map(([key, spec]) => {
      const name = `orchestrion:${pkg}:${spec.channelName}`;
      return [
        key,
        {
          ...spec,
          intercept: (interceptor: Interceptor<AnySpec>) =>
            newGlobalInvocationHook(name).intercept(interceptor),
          invoke: (
            target: (...args: any[]) => any,
            receiver: unknown,
            args: unknown[],
            additional: object,
          ) =>
            newGlobalInvocationHook(name).invoke(
              target,
              receiver,
              args,
              additional,
            ),
        },
      ];
    }),
  ) as unknown as { [K in keyof T]: InvocationChannel<T[K]> };
}
