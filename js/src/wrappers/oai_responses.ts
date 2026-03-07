import type { ArgsOf, ResultOf } from "../instrumentation/core";
import { openAIChannels } from "../instrumentation/plugins/openai-channels";
import { parseMetricsFromUsage } from "../openai-utils";
import {
  APIPromise,
  createChannelContext,
  createLazyAPIPromise,
  EnhancedResponse,
  splitSpanInfo,
  tracePromiseWithResponse,
} from "./openai-promise-utils";

type SpanInfo = {
  span_info?: Record<string, unknown>;
};

export function responsesProxy(openai: any) {
  // This was added in v4.87.0 of the openai-node library
  if (!openai.responses) {
    return openai;
  }

  return new Proxy(openai.responses, {
    get(target, name, receiver) {
      if (name === "create") {
        return wrapResponsesAsync(
          target.create.bind(target),
          openAIChannels.responsesCreate,
        );
      } else if (name === "stream") {
        return wrapResponsesSyncStream(
          target.stream.bind(target),
          openAIChannels.responsesStream,
        );
      } else if (name === "parse") {
        return wrapResponsesAsync(
          target.parse.bind(target),
          openAIChannels.responsesParse,
        );
      }
      return Reflect.get(target, name, receiver);
    },
  });
}

function wrapResponsesAsync<
  TChannel extends
    | typeof openAIChannels.responsesCreate
    | typeof openAIChannels.responsesParse,
>(
  target: (
    params: ArgsOf<TChannel>[0],
    options?: unknown,
  ) => APIPromise<ResultOf<TChannel>>,
  channel: TChannel,
): (
  params: ArgsOf<TChannel>[0] & SpanInfo,
  options?: unknown,
) => APIPromise<ResultOf<TChannel>> {
  return (
    allParams: ArgsOf<TChannel>[0] & SpanInfo,
    options?: unknown,
  ): APIPromise<ResultOf<TChannel>> => {
    const { span_info, params } = splitSpanInfo<
      ArgsOf<TChannel>[0],
      SpanInfo["span_info"]
    >(allParams);

    let executionPromise: Promise<EnhancedResponse<ResultOf<TChannel>>> | null =
      null;

    const ensureExecuted = (): Promise<
      EnhancedResponse<ResultOf<TChannel>>
    > => {
      if (!executionPromise) {
        executionPromise = (async () => {
          const traceContext = createChannelContext(channel, params, span_info);
          const apiPromise = target(params, options);
          return tracePromiseWithResponse(channel, traceContext, apiPromise);
        })();
      }

      return executionPromise;
    };

    return createLazyAPIPromise(ensureExecuted);
  };
}

function wrapResponsesSyncStream<TResult>(
  target: (
    params: ArgsOf<typeof openAIChannels.responsesStream>[0],
    options?: unknown,
  ) => TResult,
  channel: typeof openAIChannels.responsesStream,
): (
  params: ArgsOf<typeof openAIChannels.responsesStream>[0] & SpanInfo,
  options?: unknown,
) => TResult {
  return (
    allParams: ArgsOf<typeof openAIChannels.responsesStream>[0] & SpanInfo,
    options?: unknown,
  ): TResult => {
    const { span_info, params } = splitSpanInfo<
      ArgsOf<typeof openAIChannels.responsesStream>[0],
      SpanInfo["span_info"]
    >(allParams);
    return channel.traceSync(() => target(params, options), {
      arguments: [params],
      span_info,
    });
  };
}

export { parseMetricsFromUsage };
