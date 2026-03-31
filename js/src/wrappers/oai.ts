/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CompiledPrompt } from "../logger";
import {
  LEGACY_CACHED_HEADER,
  parseCachedHeader,
  X_CACHED_HEADER,
} from "../openai-utils";
import { responsesProxy } from "./oai_responses";
import type {
  ArgsOf,
  ResultOf,
} from "../instrumentation/core/channel-definitions";
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

type OpenAILike = OpenAIV4Client;

export function wrapOpenAIv4<T extends OpenAILike>(openai: T): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const typedOpenai = openai as OpenAIV4Client;
  // Recover `this` for fallback methods so private fields and internal slots
  // keep seeing the original OpenAI instance instead of the proxy.
  const privateMethodWorkaroundCache = new WeakMap<
    (...args: unknown[]) => unknown,
    (...args: unknown[]) => unknown
  >();

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
  const topLevelProxy = new Proxy(typedOpenai, {
    get(target, name) {
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

      // The following rather convoluted code is a workaround for https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1693
      // The problem is that Proxies are inherently difficult to work with native private class fields because when a
      // class function accesses a private field, JS checks whether `this` is equal to the actual instance with the
      // private field and if that's not the case, it throws a `TypeError`.
      // We could have also done `if (typeof value === "function") return value.bind(target);`, but it would have
      // created a new function on each function access, so we are caching, and also it would have always stomped on
      // someone passing another `this` which may clash with different instrumentations.

      // Use the real client as receiver when reading fallback members.
      const value = Reflect.get(target, name, target);
      if (typeof value !== "function") {
        return value;
      }

      const cachedValue = privateMethodWorkaroundCache.get(value);
      if (cachedValue) {
        return cachedValue;
      }

      const thisBoundValue = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        // Calling through the proxy would set `this` to the proxy and break
        // native private-field methods, so recover the original target.
        const thisArg = this === topLevelProxy ? target : this;
        const output = Reflect.apply(value, thisArg, args);
        // Preserve chaining on wrapped clients (method returns `this`).
        return output === target ? topLevelProxy : output;
      };

      privateMethodWorkaroundCache.set(value, thisBoundValue);
      return thisBoundValue;
    },
  });

  return topLevelProxy as T;
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
) => APIPromise<ResultOf<TChannel>> {
  return (allParams: ArgsOf<TChannel>[0] & SpanInfo, options?: unknown) => {
    const { span_info, params } = splitSpanInfo<
      ArgsOf<TChannel>[0],
      SpanInfo["span_info"]
    >(allParams);
    let executionPromise: Promise<EnhancedResponse<ResultOf<TChannel>>> | null =
      null;
    const ensureExecuted = () => {
      if (!executionPromise) {
        executionPromise = (async () => {
          const traceContext = createChannelContext(channel, params, span_info);
          return tracePromiseWithResponse(
            channel,
            traceContext,
            create(params, options),
          );
        })();
      }
      return executionPromise;
    };
    return createLazyAPIPromise(ensureExecuted);
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
