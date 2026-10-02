import { markInvocationContext } from "../global-instrumentation-hooks";
import type {
  ArgsOf,
  ExtraOf,
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
  request_id?: string | null;
};

export interface APIPromise<T> extends Promise<T> {
  withResponse(): Promise<EnhancedResponse<T>>;
  asResponse(): Promise<Response>;
}

type ChannelContext<TChannel extends OpenAIAsyncChannel> =
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

/**
 * Wrap an APIPromise method so the request is traced when its result is first
 * consumed, while preserving lazy execution, withResponse(), and asResponse().
 */
export function wrapAPIPromiseMethod<TChannel extends OpenAIAsyncChannel>(
  channel: TChannel,
  method: (
    params: ChannelParam<TChannel>,
    options?: unknown,
  ) => APIPromise<ResultOf<TChannel>>,
): (
  params: ChannelParam<TChannel> & Pick<ChannelContext<TChannel>, "span_info">,
  options?: unknown,
) => APIPromise<ResultOf<TChannel>> {
  type TResult = ResultOf<TChannel>;
  const invoke =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    channel.invoke as unknown as <T>(
      target: () => Promise<T>,
      thisArg: undefined,
      args: [ChannelParam<TChannel>],
      additional: ExtraOf<TChannel>,
    ) => Promise<T>;
  const tracePromise =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    channel.tracePromise as unknown as <T>(
      fn: () => Promise<T>,
      context: ChannelContext<TChannel>,
    ) => Promise<T>;

  return (allParams, options) => {
    const { span_info, params } = splitSpanInfo(allParams);
    // Lazy execution avoids unhandled rejections when the request fails
    // before the application attaches its handlers.
    let apiPromise: APIPromise<TResult> | undefined;
    const getAPIPromise = () => (apiPromise ??= method(params, options));
    const consume = <T>(
      read: (
        apiPromise: APIPromise<TResult>,
      ) => Promise<{ value: T; response: Response }>,
    ): Promise<T> => {
      // The request starts before the traced call, as with the unwrapped SDK.
      const request = getAPIPromise();
      const responseHolder: { response?: Response } = {};
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const additional = { span_info, responseHolder } as ExtraOf<TChannel>;
      // Spans come from the invocation hook. The surrounding lifecycle keeps
      // events for existing tracing-channel subscribers of these calls, and
      // its context is marked so span-creating legacy subscribers skip it.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const context = markInvocationContext({
        arguments: [params],
        span_info,
      } as ChannelContext<TChannel>);
      return tracePromise(
        () =>
          invoke(
            async () => {
              const { value, response } = await read(request);
              context.response = responseHolder.response = response;
              return value;
            },
            undefined,
            [params],
            additional,
          ),
        context,
      );
    };

    return createLazyAPIPromise(
      async () => {
        let enhanced: EnhancedResponse<TResult> | undefined;
        const data = await consume(async (apiPromise) => {
          enhanced = await apiPromise.withResponse();
          return { value: enhanced.data, response: enhanced.response };
        });
        const { response, request_id } = enhanced!;
        return { data, response, request_id };
      },
      async () => {
        let response: Response | undefined;
        // The traced value stays undefined because the body is not parsed.
        await consume(async (apiPromise) => {
          response = await apiPromise.asResponse();
          return { value: undefined, response };
        });
        return response!;
      },
      getAPIPromise,
    );
  };
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
