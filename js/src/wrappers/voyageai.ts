import { voyageAIChannels } from "../instrumentation/plugins/voyageai-channels";
import type {
  VoyageAIClient,
  VoyageAIContextualizedEmbedRequest,
  VoyageAIEmbedRequest,
  VoyageAIMultimodalEmbedRequest,
  VoyageAIRerankRequest,
} from "../vendor-sdk-types/voyageai";

/**
 * Wrap a Voyage AI client so method calls pass through the Braintrust
 * instrumentation hooks.
 */
export function wrapVoyageAI<T>(client: T): T {
  if (!isSupportedVoyageAIClient(client)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported Voyage AI library. Not wrapping.");
    return client;
  }

  return voyageAIProxy(client) as T;
}

const voyageAIProxyCache = new WeakMap<VoyageAIClient, VoyageAIClient>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(value: Record<string, unknown>, name: string): boolean {
  return typeof Reflect.get(value, name) === "function";
}

function isSupportedVoyageAIClient(value: unknown): value is VoyageAIClient {
  if (!isObject(value)) {
    return false;
  }

  return (
    hasFunction(value, "embed") ||
    hasFunction(value, "multimodalEmbed") ||
    hasFunction(value, "rerank") ||
    hasFunction(value, "contextualizedEmbed")
  );
}

function voyageAIProxy(client: VoyageAIClient): VoyageAIClient {
  const cached = voyageAIProxyCache.get(client);
  if (cached) {
    return cached;
  }

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      switch (prop) {
        case "embed":
          if (typeof target.embed !== "function") {
            return target.embed;
          }
          return (request: VoyageAIEmbedRequest, options?: unknown) =>
            voyageAIChannels.embed.invoke(
              target.embed!,
              target,
              [request, options],
              {},
            );
        case "multimodalEmbed":
          if (typeof target.multimodalEmbed !== "function") {
            return target.multimodalEmbed;
          }
          return (request: VoyageAIMultimodalEmbedRequest, options?: unknown) =>
            voyageAIChannels.multimodalEmbed.invoke(
              target.multimodalEmbed!,
              target,
              [request, options],
              {},
            );
        case "rerank":
          if (typeof target.rerank !== "function") {
            return target.rerank;
          }
          return (request: VoyageAIRerankRequest, options?: unknown) =>
            voyageAIChannels.rerank.invoke(
              target.rerank!,
              target,
              [request, options],
              {},
            );
        case "contextualizedEmbed":
          if (typeof target.contextualizedEmbed !== "function") {
            return target.contextualizedEmbed;
          }
          return (
            request: VoyageAIContextualizedEmbedRequest,
            options?: unknown,
          ) =>
            voyageAIChannels.contextualizedEmbed.invoke(
              target.contextualizedEmbed!,
              target,
              [request, options],
              {},
            );
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });

  voyageAIProxyCache.set(client, proxy);
  return proxy;
}
