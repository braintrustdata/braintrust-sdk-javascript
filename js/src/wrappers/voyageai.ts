import { voyageAIChannels } from "../instrumentation/plugins/voyageai-channels";
import type {
  VoyageAIClient,
  VoyageAIContextualizedEmbedRequest,
  VoyageAIContextualizedResult,
  VoyageAIEmbeddingResponse,
  VoyageAIEmbedRequest,
  VoyageAIMultimodalEmbedRequest,
  VoyageAIRerankRequest,
  VoyageAIRerankResponse,
  VoyageAIResponsePromise,
} from "../vendor-sdk-types/voyageai";

/**
 * Wrap a Voyage AI client so method calls emit diagnostics-channel events that
 * Braintrust plugins can consume.
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
          return typeof target.embed === "function"
            ? wrapEmbed(target.embed.bind(target))
            : target.embed;
        case "multimodalEmbed":
          return typeof target.multimodalEmbed === "function"
            ? wrapMultimodalEmbed(target.multimodalEmbed.bind(target))
            : target.multimodalEmbed;
        case "rerank":
          return typeof target.rerank === "function"
            ? wrapRerank(target.rerank.bind(target))
            : target.rerank;
        case "contextualizedEmbed":
          return typeof target.contextualizedEmbed === "function"
            ? wrapContextualizedEmbed(target.contextualizedEmbed.bind(target))
            : target.contextualizedEmbed;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });

  voyageAIProxyCache.set(client, proxy);
  return proxy;
}

function wrapEmbed(
  embed: (
    request: VoyageAIEmbedRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIEmbeddingResponse>,
): NonNullable<VoyageAIClient["embed"]> {
  return (request, options) =>
    voyageAIChannels.embed.tracePromise(() => embed(request, options), {
      arguments: [request],
    });
}

function wrapMultimodalEmbed(
  multimodalEmbed: (
    request: VoyageAIMultimodalEmbedRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIEmbeddingResponse>,
): NonNullable<VoyageAIClient["multimodalEmbed"]> {
  return (request, options) =>
    voyageAIChannels.multimodalEmbed.tracePromise(
      () => multimodalEmbed(request, options),
      {
        arguments: [request],
      },
    );
}

function wrapRerank(
  rerank: (
    request: VoyageAIRerankRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIRerankResponse>,
): NonNullable<VoyageAIClient["rerank"]> {
  return (request, options) =>
    voyageAIChannels.rerank.tracePromise(() => rerank(request, options), {
      arguments: [request],
    });
}

function wrapContextualizedEmbed(
  contextualizedEmbed: (
    request: VoyageAIContextualizedEmbedRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIContextualizedResult>,
): NonNullable<VoyageAIClient["contextualizedEmbed"]> {
  return (request, options) =>
    voyageAIChannels.contextualizedEmbed.tracePromise(
      () => contextualizedEmbed(request, options),
      {
        arguments: [request],
      },
    );
}
