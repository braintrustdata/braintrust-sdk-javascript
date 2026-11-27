import { isObject } from "../../util";
import { debugLogger } from "../debug-logger";
import { retellChannels } from "../instrumentation/providers/retell-interceptors";
import { registerInstrumentation } from "../instrumentation/registrations/retell";
import type { RetellArgs } from "../vendor-sdk-types/retell";

const clients = new WeakMap<object, object>();

/** Trace Retell SDK 6.2.22+ call and chat execution requests. */
export function wrapRetell<T>(client: T): T;
export function wrapRetell(client: unknown): unknown {
  registerInstrumentation();
  if (!isObject(client) || !isObject(client.call) || !isObject(client.chat)) {
    debugLogger.notice.warn("Unsupported Retell client. Not wrapping.");
    return client;
  }
  const cached = clients.get(client);
  if (cached) return cached;
  const wrapResource = (
    resource: Record<string, unknown>,
    kind: "call" | "chat",
  ) =>
    new Proxy(resource, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        const hook =
          kind === "call"
            ? key === "createPhoneCall"
              ? retellChannels.createPhoneCall
              : key === "createWebCall"
                ? retellChannels.createWebCall
                : key === "retrieve"
                  ? retellChannels.retrieveCall
                  : undefined
            : key === "create"
              ? retellChannels.createChat
              : key === "createChatCompletion"
                ? retellChannels.createChatCompletion
                : undefined;
        return hook
          ? (...args: RetellArgs) => hook.invoke(value, target, args, {})
          : value.bind(target);
      },
    });
  const call = wrapResource(client.call, "call");
  const chat = wrapResource(client.chat, "chat");
  const wrapped = new Proxy(client, {
    get(target, key) {
      if (key === "call") return call;
      if (key === "chat") return chat;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  clients.set(client, wrapped);
  clients.set(wrapped, wrapped);
  return wrapped;
}
