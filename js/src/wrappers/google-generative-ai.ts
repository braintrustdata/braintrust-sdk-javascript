import { googleGenerativeAIChannels } from "../instrumentation/plugins/google-generative-ai-channels";
import { isObject } from "../util";
import type {
  GenerativeAIClient,
  GenerativeAIModel,
  GenerativeAIChat,
} from "../vendor-sdk-types/google-generative-ai";

/** Trace @google/generative-ai model and chat calls through Braintrust. */
export function wrapGoogleGenerativeAI<T>(client: T): T {
  if (!isObject(client) || typeof client.getGenerativeModel !== "function")
    return client;
  return wrapClient(client as unknown as GenerativeAIClient) as T;
}

const proxies = new WeakMap<object, object>();

function wrapClient<
  T extends GenerativeAIClient | GenerativeAIModel | GenerativeAIChat,
>(client: T): T {
  const cached = proxies.get(client);
  if (cached) return cached as T;
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (
        prop === "getGenerativeModel" ||
        prop === "getGenerativeModelFromCachedContent" ||
        prop === "startChat"
      ) {
        return (...args: unknown[]) =>
          wrapClient(Reflect.apply(value, target, args));
      }
      switch (prop) {
        case "generateContent":
          return (...args: Parameters<GenerativeAIModel["generateContent"]>) =>
            googleGenerativeAIChannels.generateContent.invoke(
              value as GenerativeAIModel["generateContent"],
              target,
              args,
              {},
            );
        case "generateContentStream":
          return (
            ...args: Parameters<GenerativeAIModel["generateContentStream"]>
          ) =>
            googleGenerativeAIChannels.generateContentStream.invoke(
              value as GenerativeAIModel["generateContentStream"],
              target,
              args,
              {},
            );
        case "embedContent":
          return (...args: Parameters<GenerativeAIModel["embedContent"]>) =>
            googleGenerativeAIChannels.embedContent.invoke(
              value as GenerativeAIModel["embedContent"],
              target,
              args,
              {},
            );
        case "batchEmbedContents":
          return (
            ...args: Parameters<GenerativeAIModel["batchEmbedContents"]>
          ) =>
            googleGenerativeAIChannels.batchEmbedContents.invoke(
              value as GenerativeAIModel["batchEmbedContents"],
              target,
              args,
              {},
            );
        case "sendMessage":
          return (...args: Parameters<GenerativeAIChat["sendMessage"]>) =>
            googleGenerativeAIChannels.sendMessage.invoke(
              value as GenerativeAIChat["sendMessage"],
              target,
              args,
              {},
            );
        case "sendMessageStream":
          return (...args: Parameters<GenerativeAIChat["sendMessageStream"]>) =>
            googleGenerativeAIChannels.sendMessageStream.invoke(
              value as GenerativeAIChat["sendMessageStream"],
              target,
              args,
              {},
            );
      }
      return value.bind(target);
    },
  });
  proxies.set(client, proxy);
  proxies.set(proxy, proxy);
  return proxy;
}
