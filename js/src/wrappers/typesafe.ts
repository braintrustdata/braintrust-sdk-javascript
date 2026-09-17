import { typeSafeChannels } from "../instrumentation/plugins/typesafe-channels";
import type {
  TypeSafeClient,
  TypeSafeSystemOneRequest,
} from "../vendor-sdk-types/typesafe";

/** Wrap a TypeSafe client so systemOne calls pass through Braintrust tracing. */
export function wrapTypeSafe<T>(client: T): T;
export function wrapTypeSafe(client: unknown): unknown {
  if (!isSupportedTypeSafeClient(client)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported TypeSafe AI library. Not wrapping.");
    return client;
  }

  const cached = typeSafeProxyCache.get(client);
  if (cached) {
    return cached;
  }

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "systemOne") {
        return Reflect.get(target, prop, receiver);
      }

      return (request: TypeSafeSystemOneRequest, options?: unknown) =>
        typeSafeChannels.systemOne.invoke(
          target.systemOne,
          target,
          [request, options],
          {},
        );
    },
  });
  typeSafeProxyCache.set(client, proxy);
  return proxy;
}

const typeSafeProxyCache = new WeakMap<TypeSafeClient, TypeSafeClient>();

function isSupportedTypeSafeClient(value: unknown): value is TypeSafeClient {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "systemOne") === "function"
  );
}
