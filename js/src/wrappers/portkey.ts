import { portkeyChannels } from "../instrumentation/plugins/portkey-channels";
import { runWithAutoInstrumentationSuppressed } from "../instrumentation/auto-instrumentation-suppression";
import type { ArgsOf } from "../instrumentation/core/channel-definitions";
import type { PortkeyClient } from "../vendor-sdk-types/portkey";
import { isObject } from "../../util/index";
import { debugLogger } from "../debug-logger";

type Create = PortkeyClient["chat"]["completions"]["create"];

const proxyCache = new WeakMap<object, object>();

/**
 * Trace chat completions from a client created with `new Portkey(...)`.
 * Supports both regular responses and `stream: true`.
 */
export function wrapPortkey<T extends object>(client: T): T {
  if (!isPortkeyClient(client)) {
    debugLogger.warn("Unsupported Portkey client. Not wrapping.");
    return client;
  }
  const cached = proxyCache.get(client);
  if (cached) return cached as T;

  const proxy = proxyPath(client, ["chat", "completions", "create"]);
  proxyCache.set(client, proxy);
  proxyCache.set(proxy, proxy);
  return proxy;
}

function isPortkeyClient(value: unknown): value is PortkeyClient {
  return (
    isObject(value) &&
    isObject(value.chat) &&
    isObject(value.chat.completions) &&
    typeof value.chat.completions.create === "function"
  );
}

function proxyPath<T extends object>(target: T, path: string[]): T {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(object, prop, receiver) {
      const value = Reflect.get(object, prop, receiver);
      if (prop !== path[0]) return value;
      if (cache.has(prop)) return cache.get(prop);

      if (path.length === 1 && typeof value === "function") {
        const wrapped = (
          ...args: ArgsOf<typeof portkeyChannels.chatCompletionsCreate>
        ) =>
          portkeyChannels.chatCompletionsCreate.tracePromise(
            () =>
              runWithAutoInstrumentationSuppressed(() =>
                Reflect.apply(value as Create, object, args),
              ),
            { arguments: args },
          );
        cache.set(prop, wrapped);
        return wrapped;
      }
      if (value !== null && typeof value === "object") {
        const wrapped = proxyPath(value, path.slice(1));
        cache.set(prop, wrapped);
        return wrapped;
      }
      return value;
    },
  });
}
