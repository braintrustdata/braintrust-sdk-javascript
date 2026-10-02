import { openRouterChannels } from "../instrumentation/plugins/openrouter-channels";
import type {
  OpenRouterBeta,
  OpenRouterClient,
} from "../vendor-sdk-types/openrouter";

/**
 * Wrap an OpenRouter client (created with `new OpenRouter(...)`) so calls pass
 * through the Braintrust instrumentation hooks.
 */
export function wrapOpenRouter<T>(openrouter: T): T {
  const or: unknown = openrouter;
  if (
    or &&
    typeof or === "object" &&
    (("chat" in or &&
      typeof or.chat === "object" &&
      or.chat &&
      "send" in or.chat &&
      "embeddings" in or &&
      typeof or.embeddings === "object" &&
      or.embeddings &&
      "generate" in or.embeddings) ||
      ("rerank" in or &&
        typeof or.rerank === "object" &&
        or.rerank &&
        "rerank" in or.rerank) ||
      ("callModel" in or && typeof or.callModel === "function"))
  ) {
    return openRouterProxy(or as OpenRouterClient) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported OpenRouter library. Not wrapping.");
  return openrouter;
}

function openRouterProxy(openrouter: OpenRouterClient): OpenRouterClient {
  return new Proxy(openrouter, {
    get(target, prop, receiver) {
      switch (prop) {
        case "chat":
          return target.chat
            ? methodProxy(target.chat, "send", openRouterChannels.chatSend)
            : target.chat;
        case "embeddings":
          return target.embeddings
            ? methodProxy(
                target.embeddings,
                "generate",
                openRouterChannels.embeddingsGenerate,
              )
            : target.embeddings;
        case "rerank":
          return target.rerank
            ? methodProxy(
                target.rerank,
                "rerank",
                openRouterChannels.rerankRerank,
              )
            : target.rerank;
        case "beta":
          return target.beta ? betaProxy(target.beta) : target.beta;
        case "callModel":
          return typeof target.callModel === "function"
            ? wrapCallModel(target)
            : target.callModel;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

function betaProxy(beta: OpenRouterBeta): OpenRouterBeta {
  return new Proxy(beta, {
    get(target, prop, receiver) {
      if (prop === "responses") {
        return target.responses
          ? methodProxy(
              target.responses,
              "send",
              openRouterChannels.betaResponsesSend,
            )
          : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function methodProxy<
  T extends Record<K, (request: never, options?: unknown) => unknown>,
  K extends string,
>(
  object: T,
  method: K,
  channel: {
    invoke(
      target: T[K],
      thisArg: T,
      args: Parameters<T[K]>,
      additional: object,
    ): unknown;
  },
): T {
  return new Proxy(object, {
    get(target, prop, receiver) {
      if (prop !== method) {
        return Reflect.get(target, prop, receiver);
      }
      const boundMethod = target[method].bind(target) as T[K];
      return (request: unknown, options?: unknown) =>
        channel.invoke(
          boundMethod,
          target,
          [request, options] as unknown as Parameters<T[K]>,
          {},
        );
    },
  });
}

function wrapCallModel(
  openrouter: OpenRouterClient,
): NonNullable<OpenRouterClient["callModel"]> {
  const callModel = openrouter.callModel!;
  return (request, options) =>
    openRouterChannels.callModel.invoke(
      callModel,
      openrouter,
      [{ ...request }, options],
      {},
    );
}
