/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CompiledPrompt } from "../logger";
import {
  LEGACY_CACHED_HEADER,
  parseCachedHeader,
  X_CACHED_HEADER,
} from "../openai-utils";
import { responsesProxy } from "./oai_responses";
import type { ArgsOf, ResultOf } from "../instrumentation/core";
import { openAIChannels } from "../instrumentation/plugins/openai-channels";
import type {
  OpenAIChatCompletion,
  OpenAIChatCreateParams,
  OpenAIChatStream,
  OpenAIClient,
  OpenAIEmbeddingCreateParams,
  OpenAIEmbeddingResponse,
  OpenAIModerationCreateParams,
  OpenAIModerationResponse,
} from "../vendor-sdk-types/openai";
import {
  APIPromise,
  createChannelContext,
  createLazyAPIPromise,
  EnhancedResponse,
  splitSpanInfo,
  tracePromiseWithResponse,
} from "./openai-promise-utils";
import { OpenAIV4Client } from "../vendor-sdk-types/openai-v4";

declare global {
  var __inherited_braintrust_wrap_openai: ((openai: any) => any) | undefined;
}

/**
 * Wrap an `OpenAI` object (created with `new OpenAI(...)`) to add tracing. If Braintrust is
 * not configured, nothing will be traced. If this is not an `OpenAI` object, this function is
 * a no-op.
 *
 * Currently, this supports the `v4`, `v5`, and `v6` API.
 *
 * @param openai
 * @returns The wrapped `OpenAI` object.
 */
export function wrapOpenAI<T extends object>(openai: T): T {
  const oai: unknown = openai;
  if (
    oai &&
    typeof oai === "object" &&
    "chat" in oai &&
    typeof oai.chat === "object" &&
    oai.chat &&
    "completions" in oai.chat &&
    typeof oai.chat.completions === "object" &&
    oai.chat.completions &&
    "create" in oai.chat.completions
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const typedOpenAI = oai as OpenAIClient;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return wrapOpenAIv4(typedOpenAI) as T;
  } else {
    console.warn("Unsupported OpenAI library (potentially v3). Not wrapping.");
    return openai;
  }
}
globalThis.__inherited_braintrust_wrap_openai = wrapOpenAI;

export function wrapOpenAIv4<T extends object>(openai: T): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const typedOpenai = openai as OpenAIV4Client;

  const completionProxy = new Proxy(typedOpenai.chat.completions, {
    get(target, name, receiver) {
      const baseVal = Reflect.get(target, name, receiver);
      if (name === "create") {
        return wrapChatCompletion(baseVal.bind(target));
      } else if (name === "parse") {
        return wrapBetaChatCompletionParse(baseVal.bind(target));
      } else if (name === "stream") {
        return wrapBetaChatCompletionStream(baseVal.bind(target));
      }
      return baseVal;
    },
  });

  const chatProxy = new Proxy(typedOpenai.chat, {
    get(target, name, receiver) {
      if (name === "completions") {
        return completionProxy;
      }
      return Reflect.get(target, name, receiver);
    },
  });

  const embeddingProxy = createEndpointProxy<
    OpenAIEmbeddingCreateParams,
    OpenAIEmbeddingResponse
  >(typedOpenai.embeddings, wrapEmbeddings);
  const moderationProxy = createEndpointProxy<
    OpenAIModerationCreateParams,
    OpenAIModerationResponse
  >(typedOpenai.moderations, wrapModerations);

  let betaProxy: OpenAIClient["beta"];
  if (typedOpenai.beta?.chat?.completions?.stream) {
    const betaChatCompletionProxy = new Proxy(
      typedOpenai?.beta?.chat.completions,
      {
        get(target, name, receiver) {
          const baseVal = Reflect.get(target, name, receiver);
          if (name === "parse") {
            return wrapBetaChatCompletionParse(baseVal.bind(target));
          } else if (name === "stream") {
            return wrapBetaChatCompletionStream(baseVal.bind(target));
          }
          return baseVal;
        },
      },
    );
    const betaChatProxy = new Proxy(typedOpenai.beta.chat, {
      get(target, name, receiver) {
        if (name === "completions") {
          return betaChatCompletionProxy;
        }
        return Reflect.get(target, name, receiver);
      },
    });
    betaProxy = new Proxy(typedOpenai.beta, {
      get(target, name, receiver) {
        if (name === "chat") {
          return betaChatProxy;
        }
        return Reflect.get(target, name, receiver);
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return new Proxy(typedOpenai, {
    get(target, name, receiver) {
      switch (name) {
        case "chat":
          return chatProxy;
        case "embeddings":
          return embeddingProxy;
        case "moderations":
          return moderationProxy;
        case "responses":
          return responsesProxy(typedOpenai);
      }

      if (name === "beta" && betaProxy) {
        return betaProxy;
      }
      return Reflect.get(target, name, receiver);
    },
  }) as T;
}

type SpanInfo = {
  span_info?: CompiledPrompt<"chat">["span_info"];
};

function wrapBetaChatCompletionParse<
  P extends OpenAIChatCreateParams,
  C extends OpenAIChatCompletion,
>(completion: (params: P) => Promise<C>): (params: P & SpanInfo) => Promise<C> {
  return async (allParams: P & SpanInfo) => {
    const { span_info, params } = splitSpanInfo<P, SpanInfo["span_info"]>(
      allParams,
    );
    return openAIChannels.betaChatCompletionsParse.tracePromise(
      async () => await completion(params),
      { arguments: [params], span_info },
    );
  };
}

function wrapBetaChatCompletionStream<P extends OpenAIChatCreateParams, C>(
  completion: (params: P) => C,
): (params: P & SpanInfo) => C {
  return (allParams: P & SpanInfo) => {
    const { span_info, params } = splitSpanInfo<P, SpanInfo["span_info"]>(
      allParams,
    );
    return openAIChannels.betaChatCompletionsStream.traceSync(
      () => completion(params),
      { arguments: [params], span_info },
    );
  };
}

export { LEGACY_CACHED_HEADER, parseCachedHeader, X_CACHED_HEADER };

function wrapChatCompletion<
  P extends OpenAIChatCreateParams,
  C extends OpenAIChatCompletion | OpenAIChatStream,
>(
  completion: (params: P, options?: unknown) => APIPromise<C>,
): (params: P, options?: unknown) => APIPromise<C> {
  return (allParams: P & SpanInfo, options?: unknown): APIPromise<C> => {
    const { span_info, params } = splitSpanInfo<P, SpanInfo["span_info"]>(
      allParams,
    );
    // Lazy execution - we must defer the API call until the promise is actually consumed
    // to avoid unhandled rejections when the underlying OpenAI call fails immediately.
    // Without lazy execution, the promise chain starts before error handlers are attached.
    let executionPromise: Promise<EnhancedResponse<C>> | null = null;

    const ensureExecuted = (): Promise<EnhancedResponse<C>> => {
      if (!executionPromise) {
        executionPromise = (async (): Promise<EnhancedResponse<C>> => {
          const traceContext = createChannelContext(
            openAIChannels.chatCompletionsCreate,
            params,
            span_info,
          );

          if (params.stream) {
            const completionPromise = completion(
              params,
              options,
            ) as APIPromise<OpenAIChatStream>;
            const { data, response } = await tracePromiseWithResponse(
              openAIChannels.chatCompletionsCreate,
              traceContext,
              completionPromise,
            );
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            return { data: data as C, response };
          }

          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          const completionResponse = completion(
            params,
            options,
          ) as APIPromise<OpenAIChatCompletion>;
          const { data, response } = await tracePromiseWithResponse(
            openAIChannels.chatCompletionsCreate,
            traceContext,
            completionResponse,
          );
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return { data: data as C, response };
        })();
      }
      return executionPromise;
    };

    return createLazyAPIPromise(ensureExecuted);
  };
}

function createEndpointProxy<T, R>(
  target: any,
  wrapperFn: (
    create: (params: T, options?: unknown) => APIPromise<R>,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  ) => Function,
) {
  return new Proxy(target, {
    get(target, name, receiver) {
      const baseVal = Reflect.get(target, name, receiver);
      if (name === "create") {
        return wrapperFn(baseVal.bind(target));
      }
      return baseVal;
    },
  });
}

function wrapApiCreateWithChannel<
  TChannel extends
    | typeof openAIChannels.embeddingsCreate
    | typeof openAIChannels.moderationsCreate,
>(
  create: (
    params: ArgsOf<TChannel>[0],
    options?: unknown,
  ) => APIPromise<ResultOf<TChannel>>,
  channel: TChannel,
): (
  params: ArgsOf<TChannel>[0] & SpanInfo,
  options?: unknown,
) => Promise<unknown> {
  return async (
    allParams: ArgsOf<TChannel>[0] & SpanInfo,
    options?: unknown,
  ) => {
    const { span_info, params } = splitSpanInfo<
      ArgsOf<TChannel>[0],
      SpanInfo["span_info"]
    >(allParams);
    const traceContext = createChannelContext(channel, params, span_info);
    const { data } = await tracePromiseWithResponse(
      channel,
      traceContext,
      create(params, options),
    );
    return data;
  };
}

const wrapEmbeddings = (
  create: (
    params: OpenAIEmbeddingCreateParams,
    options?: unknown,
  ) => APIPromise<OpenAIEmbeddingResponse>,
) => wrapApiCreateWithChannel(create, openAIChannels.embeddingsCreate);

const wrapModerations = (
  create: (
    params: OpenAIModerationCreateParams,
    options?: unknown,
  ) => APIPromise<OpenAIModerationResponse>,
) => wrapApiCreateWithChannel(create, openAIChannels.moderationsCreate);
