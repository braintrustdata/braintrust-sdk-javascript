import { cohereChannels } from "../instrumentation/plugins/cohere-channels";
import type { CohereClient } from "../vendor-sdk-types/cohere";

/**
 * Wrap a Cohere client so method calls pass through the Braintrust
 * instrumentation hooks.
 */
export function wrapCohere<T>(cohere: T): T {
  if (isSupportedCohereClient(cohere)) {
    return cohereProxy(cohere) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported Cohere library. Not wrapping.");
  return cohere;
}

const cohereProxyCache = new WeakMap<CohereClient, CohereClient>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(value: unknown, methodName: string): boolean {
  return (
    isRecord(value) &&
    methodName in value &&
    typeof value[methodName] === "function"
  );
}

function isSupportedCohereClient(value: unknown): value is CohereClient {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasFunction(value, "chat") ||
    hasFunction(value, "chatStream") ||
    hasFunction(value, "embed") ||
    hasFunction(value, "rerank")
  );
}

function cohereProxy(cohere: CohereClient): CohereClient {
  const cached = cohereProxyCache.get(cohere);
  if (cached) {
    return cached;
  }

  const proxy = new Proxy(cohere, {
    get(target, prop, receiver) {
      switch (prop) {
        case "chat":
          return invokeThroughChannel(cohereChannels.chat, target.chat, target);
        case "chatStream":
          return invokeThroughChannel(
            cohereChannels.chatStream,
            target.chatStream,
            target,
          );
        case "embed":
          return invokeThroughChannel(
            cohereChannels.embed,
            target.embed,
            target,
          );
        case "rerank":
          return invokeThroughChannel(
            cohereChannels.rerank,
            target.rerank,
            target,
          );
        default: {
          const value = Reflect.get(target, prop, receiver);
          return isSupportedCohereClient(value) ? cohereProxy(value) : value;
        }
      }
    },
  });

  cohereProxyCache.set(cohere, proxy);
  return proxy;
}

function invokeThroughChannel<TRequest, TResult>(
  channel: {
    invoke(
      target: (request: TRequest, options?: unknown) => Promise<TResult>,
      thisArg: CohereClient,
      args: [TRequest, unknown?],
      additional: Record<string, never>,
    ): Promise<TResult>;
  },
  method:
    | ((request: TRequest, options?: unknown) => Promise<TResult>)
    | undefined,
  client: CohereClient,
) {
  return typeof method === "function"
    ? (request: TRequest, options?: unknown) =>
        channel.invoke(method, client, [request, options], {})
    : method;
}
