import type {
  OpenAIMediaClient,
  OpenAIMediaMethod,
  OpenAIMediaParams,
} from "../vendor-sdk-types/openai-media";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CompiledPrompt } from "../logger";
import {
  LEGACY_CACHED_HEADER,
  parseCachedHeader,
  X_CACHED_HEADER,
} from "../openai-utils";
import { responsesProxy } from "./oai_responses";
import { openAIChannels } from "../instrumentation/plugins/openai-channels";
import type {
  OpenAIChatCompletion,
  OpenAIChatCreateParams,
  OpenAIClient,
} from "../vendor-sdk-types/openai";
import { splitSpanInfo, wrapAPIPromiseMethod } from "./openai-promise-utils";
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
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
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
        return wrapAPIPromiseMethod(
          openAIChannels.chatCompletionsCreate,
          baseVal.bind(target),
        );
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

  const embeddingProxy = createEndpointProxy(
    typedOpenai.embeddings,
    openAIChannels.embeddingsCreate,
  );
  const moderationProxy = createEndpointProxy(
    typedOpenai.moderations,
    openAIChannels.moderationsCreate,
  );
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

  const mediaProxy = (
    resource:
      | NonNullable<OpenAIMediaClient["images"]>
      | {
          create: OpenAIMediaMethod;
        },
    channels: Record<string, typeof openAIChannels.imagesGenerate>,
  ) =>
    new Proxy(resource, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        const channel =
          typeof key === "string" && Object.hasOwn(channels, key)
            ? channels[key]
            : undefined;
        if (channel && typeof value === "function")
          return (allParams: OpenAIMediaParams, options?: unknown) => {
            const { span_info, params } = splitSpanInfo<
              OpenAIMediaParams,
              SpanInfo["span_info"]
            >(allParams);
            return channel.invoke(value, target, [params, options], {
              span_info,
            });
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const imagesProxy =
    typedOpenai.images &&
    mediaProxy(typedOpenai.images, {
      generate: openAIChannels.imagesGenerate,
      edit: openAIChannels.imagesEdit,
      createVariation: openAIChannels.imagesCreateVariation,
    });
  const audioProxy =
    typedOpenai.audio &&
    new Proxy(typedOpenai.audio, {
      get(target, key) {
        if (key === "speech")
          return mediaProxy(target.speech, {
            create: openAIChannels.audioSpeechCreate,
          });
        if (key === "transcriptions")
          return mediaProxy(target.transcriptions, {
            create: openAIChannels.audioTranscriptionsCreate,
          });
        if (key === "translations")
          return mediaProxy(target.translations, {
            create: openAIChannels.audioTranslationsCreate,
          });
        return Reflect.get(target, key, target);
      },
    });

  const topLevelProxy = new Proxy(typedOpenai, {
    get(target, name) {
      switch (name) {
        case "images":
          return imagesProxy;
        case "audio":
          return audioProxy;
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

function wrapBetaChatCompletionParse(
  completion: (params: OpenAIChatCreateParams) => Promise<OpenAIChatCompletion>,
): (
  params: OpenAIChatCreateParams & SpanInfo,
) => Promise<OpenAIChatCompletion> {
  return async (allParams) => {
    const { span_info, params } = splitSpanInfo(allParams);
    return openAIChannels.betaChatCompletionsParse.invoke(
      completion,
      undefined,
      [params],
      { span_info },
    );
  };
}

function wrapBetaChatCompletionStream<C>(
  completion: (params: OpenAIChatCreateParams) => C,
): (params: OpenAIChatCreateParams & SpanInfo) => C {
  return (allParams) => {
    const { span_info, params } = splitSpanInfo(allParams);
    return openAIChannels.betaChatCompletionsStream.invoke(
      completion,
      undefined,
      [params],
      { span_info },
    );
  };
}

export { LEGACY_CACHED_HEADER, parseCachedHeader, X_CACHED_HEADER };

function createEndpointProxy(
  target: any,
  channel:
    | typeof openAIChannels.embeddingsCreate
    | typeof openAIChannels.moderationsCreate,
) {
  return new Proxy(target, {
    get(target, name, receiver) {
      const baseVal = Reflect.get(target, name, receiver);
      if (name === "create") {
        return wrapAPIPromiseMethod(channel, baseVal.bind(target));
      }
      return baseVal;
    },
  });
}
