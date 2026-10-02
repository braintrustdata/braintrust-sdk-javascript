import type { ChannelSpanInfo } from "../instrumentation/core/types";
import { openAIChannels } from "../instrumentation/plugins/openai-channels";
import { parseMetricsFromUsage } from "../openai-utils";
import type { OpenAIResponseCreateParams } from "../vendor-sdk-types/openai";
import { splitSpanInfo, wrapAPIPromiseMethod } from "./openai-promise-utils";

export function responsesProxy(openai: any) {
  // This was added in v4.87.0 of the openai-node library
  if (!openai.responses) {
    return openai;
  }

  return new Proxy(openai.responses, {
    get(target, name, receiver) {
      if (name === "create" && typeof target.create === "function") {
        return wrapAPIPromiseMethod(
          openAIChannels.responsesCreate,
          target.create.bind(target),
        );
      } else if (name === "stream" && typeof target.stream === "function") {
        return wrapResponsesSyncStream(target.stream.bind(target));
      } else if (name === "parse" && typeof target.parse === "function") {
        return wrapAPIPromiseMethod(
          openAIChannels.responsesParse,
          target.parse.bind(target),
        );
      } else if (name === "compact" && typeof target.compact === "function") {
        return wrapAPIPromiseMethod(
          openAIChannels.responsesCompact,
          target.compact.bind(target),
        );
      }
      return Reflect.get(target, name, receiver);
    },
  });
}

function wrapResponsesSyncStream<TResult>(
  target: (params: OpenAIResponseCreateParams, options?: unknown) => TResult,
): (
  params: OpenAIResponseCreateParams & { span_info?: ChannelSpanInfo },
  options?: unknown,
) => TResult {
  return (allParams, options) => {
    const { span_info, params } = splitSpanInfo(allParams);
    return openAIChannels.responsesStream.invoke(
      (params) => target(params, options),
      undefined,
      [params],
      { span_info },
    );
  };
}

export { parseMetricsFromUsage };
