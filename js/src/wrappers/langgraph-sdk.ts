import { registerInstrumentation } from "../instrumentation/registrations/langgraphSDK";
import { isObject } from "../../util";
import { debugLogger } from "../debug-logger";
import { langGraphSDKChannels } from "../instrumentation/providers/langgraph-sdk-interceptors";
import type { LangGraphSDKClient } from "../vendor-sdk-types/langgraph-sdk";

const clients = new WeakMap<LangGraphSDKClient, LangGraphSDKClient>();

/** Trace LangGraph Platform run submission and result consumption. */
export function wrapLangGraphSDK<T>(client: T): T {
  registerInstrumentation();
  const runsClient = isObject(client) ? client.runs : undefined;
  if (
    !isObject(client) ||
    !isObject(runsClient) ||
    !["wait", "stream"].every((key) => typeof runsClient[key] === "function")
  ) {
    debugLogger.notice.warn("Unsupported LangGraph SDK client. Not wrapping.");
    return client;
  }
  const sdk = client as unknown as LangGraphSDKClient;
  const cached = clients.get(sdk);
  if (cached) return cached as T;
  const runs = new Proxy(sdk.runs, {
    get(target, key) {
      switch (key) {
        case "create": {
          const method = target.create;
          if (typeof method === "function")
            return (...args: Parameters<typeof method>) =>
              langGraphSDKChannels.create.invoke(method, target, args, {});
          return method;
        }
        case "createBatch": {
          const method = target.createBatch;
          if (typeof method === "function")
            return (...args: Parameters<typeof method>) =>
              langGraphSDKChannels.createBatch.invoke(method, target, args, {});
          return method;
        }
        case "join": {
          const method = target.join;
          if (typeof method === "function")
            return (...args: Parameters<typeof method>) =>
              langGraphSDKChannels.join.invoke(method, target, args, {});
          return method;
        }
        case "joinStream": {
          const method = target.joinStream;
          if (typeof method === "function")
            return (...args: Parameters<typeof method>) =>
              langGraphSDKChannels.joinStream.invoke(method, target, args, {});
          return method;
        }
        case "wait":
          return (...args: Parameters<typeof target.wait>) =>
            langGraphSDKChannels.wait.invoke(target.wait, target, args, {});
        case "stream":
          return (...args: Parameters<typeof target.stream>) =>
            langGraphSDKChannels.stream.invoke(target.stream, target, args, {});
        default:
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
      }
    },
  });
  const wrapped = new Proxy(sdk, {
    get(target, key) {
      if (key === "runs") return runs;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  clients.set(sdk, wrapped);
  clients.set(wrapped, wrapped);
  return wrapped as T;
}
