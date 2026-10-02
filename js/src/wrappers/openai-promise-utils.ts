import type {
  ArgsOf,
  InvocationAdditionalOf,
} from "../instrumentation/core/channel-definitions";
import type { ResultOf } from "../instrumentation/core/tracing-types";
import type {
  OpenAIAsyncChannel,
  OpenAIChannel,
} from "../instrumentation/plugins/openai-channels";

export type EnhancedResponse<T> = {
  response: Response;
  data: T;
  request_id?: string | null;
};

export interface APIPromise<T> extends Promise<T> {
  withResponse(): Promise<EnhancedResponse<T>>;
  asResponse(): Promise<Response>;
}

type ChannelContext<TChannel extends OpenAIAsyncChannel> =
  InvocationAdditionalOf<TChannel> & { arguments: ArgsOf<TChannel> };

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
    responseInfo: {},
  } as ChannelContext<TChannel>;
}

export async function invokeWithResponse<
  TChannel extends OpenAIAsyncChannel,
  TResult extends ResultOf<TChannel>,
>(
  channel: TChannel,
  traceContext: ChannelContext<TChannel>,
  apiPromise: APIPromise<TResult>,
): Promise<EnhancedResponse<TResult>> {
  let enhancedResponse: EnhancedResponse<TResult> | undefined;
  const invoke = channel.invoke as <T>(
    call: () => T,
    receiver: undefined,
    args: unknown[],
    additional: ChannelContext<TChannel>,
  ) => T;

  const data = await invoke(
    async () => {
      enhancedResponse = await apiPromise.withResponse();
      traceContext.responseInfo!.response = enhancedResponse.response;
      return enhancedResponse.data;
    },
    undefined,
    traceContext.arguments,
    traceContext,
  );

  if (!enhancedResponse) {
    throw new Error("Expected withResponse() to provide response");
  }

  return {
    data,
    response: enhancedResponse.response,
    request_id: enhancedResponse.request_id,
  };
}

export async function invokeAsResponse<
  TChannel extends OpenAIAsyncChannel,
  TResult extends ResultOf<TChannel>,
>(
  channel: TChannel,
  traceContext: ChannelContext<TChannel>,
  apiPromise: APIPromise<TResult>,
): Promise<Response> {
  const invoke = channel.invoke as <T>(
    call: () => T,
    receiver: undefined,
    args: unknown[],
    additional: ChannelContext<TChannel>,
  ) => T;

  let response: Response | undefined;
  await invoke(
    async () => {
      response = await apiPromise.asResponse();
      traceContext.responseInfo!.response = response;
      return undefined;
    },
    undefined,
    traceContext.arguments,
    traceContext,
  );

  if (!response) {
    throw new Error("Expected asResponse() to provide response");
  }
  return response;
}

export function createLazyAPIPromise<TResult>(
  ensureExecuted: () => Promise<EnhancedResponse<TResult>>,
  ensureResponse: () => Promise<Response>,
  getAPIPromise: () => APIPromise<TResult>,
): APIPromise<TResult> {
  let firstConsumption: "data" | "response" | undefined;
  let enhancedResponsePromise: Promise<EnhancedResponse<TResult>> | undefined;
  let dataPromise: Promise<TResult> | undefined;
  let responsePromise: Promise<Response> | undefined;

  const withResponse = () => {
    firstConsumption ??= "data";
    enhancedResponsePromise ??=
      firstConsumption === "data"
        ? ensureExecuted()
        : getAPIPromise().withResponse();
    return enhancedResponsePromise;
  };

  const asResponse = () => {
    firstConsumption ??= "response";
    responsePromise ??=
      firstConsumption === "response"
        ? ensureResponse()
        : getAPIPromise().asResponse();
    return responsePromise;
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return new Proxy({} as APIPromise<TResult>, {
    get(target, prop, receiver) {
      if (prop === "withResponse") {
        return withResponse;
      }

      if (prop === "asResponse") {
        return asResponse;
      }

      if (
        prop === "then" ||
        prop === "catch" ||
        prop === "finally" ||
        prop in Promise.prototype
      ) {
        dataPromise ??= withResponse().then((result) => result.data);
        const value = Reflect.get(dataPromise, prop, receiver);
        return typeof value === "function" ? value.bind(dataPromise) : value;
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as APIPromise<TResult>;
}
