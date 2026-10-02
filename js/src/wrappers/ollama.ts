import { debugLogger } from "../debug-logger";
import { markInvocationContext } from "../global-instrumentation-hooks";
import { ollamaChannels } from "../instrumentation/plugins/ollama-channels";
import { isObject } from "../../util";
import type { OllamaClient } from "../vendor-sdk-types/ollama";

/**
 * Wrap an Ollama client so generation and embedding calls pass through the
 * Braintrust instrumentation hooks.
 */
export function wrapOllama<T>(ollama: T): T {
  if (isSupportedOllamaClient(ollama)) {
    return ollamaProxy(ollama) as T;
  }

  debugLogger.warn("Unsupported Ollama library. Not wrapping.");
  return ollama;
}

const ollamaProxyCache = new WeakMap<OllamaClient, OllamaClient>();
const methods = ["chat", "generate", "embed"] as const;
type OllamaMethod = (typeof methods)[number];

function isSupportedOllamaClient(value: unknown): value is OllamaClient {
  return (
    isObject(value) && methods.some((name) => typeof value[name] === "function")
  );
}

function isOllamaMethod(prop: PropertyKey): prop is OllamaMethod {
  return methods.some((name) => name === prop);
}

function ollamaProxy(ollama: OllamaClient): OllamaClient {
  const cached = ollamaProxyCache.get(ollama);
  if (cached) {
    return cached;
  }

  const wrappers = new Map<
    OllamaMethod,
    { source: unknown; wrapped: unknown }
  >();
  const getWrapped = <K extends OllamaMethod>(method: K): OllamaClient[K] => {
    const source = ollama[method];
    const entry = wrappers.get(method);
    if (entry && entry.source === source) {
      return entry.wrapped as OllamaClient[K];
    }
    const wrapped =
      typeof source === "function"
        ? wrapMethod[method](source, ollama)
        : source;
    wrappers.set(method, { source, wrapped });
    return wrapped;
  };
  const proxy = new Proxy(ollama, {
    get(target, prop, receiver) {
      return isOllamaMethod(prop)
        ? getWrapped(prop)
        : Reflect.get(target, prop, receiver);
    },
  });
  ollamaProxyCache.set(ollama, proxy);
  ollamaProxyCache.set(proxy, proxy);
  return proxy;
}

// The outer tracePromise keeps the legacy tracing lifecycle available to
// existing channel consumers, matching generated auto-instrumentation wrappers.
// Spans are created only by the invocation hook, so the context is marked.
const wrapMethod: {
  [K in OllamaMethod]: (
    source: NonNullable<OllamaClient[K]>,
    client: OllamaClient,
  ) => OllamaClient[K];
} = {
  chat: (chat, client) => (request) =>
    ollamaChannels.chat.tracePromise(
      () => ollamaChannels.chat.invoke(chat, client, [request], {}),
      markInvocationContext({ arguments: [request] }),
    ),
  generate: (generate, client) => (request) =>
    ollamaChannels.generate.tracePromise(
      () => ollamaChannels.generate.invoke(generate, client, [request], {}),
      markInvocationContext({ arguments: [request] }),
    ),
  embed: (embed, client) => (request) =>
    ollamaChannels.embed.tracePromise(
      () => ollamaChannels.embed.invoke(embed, client, [request], {}),
      markInvocationContext({ arguments: [request] }),
    ),
};
