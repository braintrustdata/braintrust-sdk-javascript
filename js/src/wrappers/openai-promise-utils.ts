import type {
  ArgsOf,
  ResultOf,
} from "../instrumentation/core/channel-definitions";
import type {
  OpenAIAsyncChannel,
  OpenAIChannel,
  OpenAIStartContext,
} from "../instrumentation/plugins/openai-channels";

export type EnhancedResponse<T> = {
  response: Response;
  data: T;
};

export interface APIPromise<T> extends Promise<T> {
  withResponse(): Promise<EnhancedResponse<T>>;
}

export type ChannelContext<TChannel extends OpenAIAsyncChannel> =
  OpenAIStartContext<TChannel>;

type ChannelParam<TChannel extends OpenAIChannel> = ArgsOf<TChannel>[0];

export function splitSpanInfo<T, TSpanInfo = unknown>(
  allParams: T & { span_info?: TSpanInfo },
): { params: T; span_info: TSpanInfo | undefined } {
  const { span_info, ...params } = allParams;
  return {
    params: params as T,
    span_info,
  };
}

export function createChannelContext<TChannel extends OpenAIAsyncChannel>(
  _channel: TChannel,
  params: ChannelParam<TChannel>,
  span_info: ChannelContext<TChannel>["span_info"],
): ChannelContext<TChannel> {
  return {
    arguments:
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      [params] as ArgsOf<TChannel>,
    span_info,
  } as ChannelContext<TChannel>;
}

export async function tracePromiseWithResponse<
  TChannel extends OpenAIAsyncChannel,
  TResult extends ResultOf<TChannel>,
>(
  channel: TChannel,
  traceContext: ChannelContext<TChannel>,
  apiPromise: APIPromise<TResult>,
): Promise<EnhancedResponse<TResult>> {
  let enhancedResponse: EnhancedResponse<TResult> | undefined;
  const tracePromise =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    channel.tracePromise as unknown as <TReturn extends Promise<TResult>>(
      fn: () => TReturn,
      context: ChannelContext<TChannel>,
    ) => TReturn;

  const data = await tracePromise(async () => {
    enhancedResponse = await apiPromise.withResponse();
    traceContext.response = enhancedResponse.response;
    return enhancedResponse.data;
  }, traceContext);

  if (!enhancedResponse) {
    throw new Error("Expected withResponse() to provide response");
  }

  return { data, response: enhancedResponse.response };
}

export function createLazyAPIPromise<TResult>(
  ensureExecuted: () => Promise<EnhancedResponse<TResult>>,
): APIPromise<TResult> {
  let dataPromise: Promise<TResult> | null = null;

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return new Proxy({} as APIPromise<TResult>, {
    get(target, prop, receiver) {
      if (prop === "withResponse") {
        return () => ensureExecuted();
      }

      if (
        prop === "then" ||
        prop === "catch" ||
        prop === "finally" ||
        prop in Promise.prototype
      ) {
        if (!dataPromise) {
          dataPromise = ensureExecuted().then((result) => result.data);
        }
        const value = Reflect.get(dataPromise, prop, receiver);
        return typeof value === "function" ? value.bind(dataPromise) : value;
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as APIPromise<TResult>;
}
