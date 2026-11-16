import { isObject } from "../../util";
import { debugLogger } from "../debug-logger";
import { falChannels } from "../instrumentation/plugins/fal-interceptors";
import type { FalArgs, FalClient } from "../vendor-sdk-types/fal";

const clients = new WeakMap<object, object>();

/** Trace model execution and finite response streams from @fal-ai/client 1.10+.
 * subscribe, queue lifecycle, storage, and realtime APIs are not instrumented.
 */
export function wrapFal<T>(client: T): T {
  if (
    !isObject(client) ||
    typeof client.run !== "function" ||
    typeof client.stream !== "function" ||
    !isObject(client.streaming) ||
    typeof client.streaming.stream !== "function"
  ) {
    debugLogger.notice.warn("Unsupported fal client. Not wrapping.");
    return client;
  }
  const cached = clients.get(client);
  if (cached) return cached as T;
  const sdk = client as unknown as FalClient;
  const methods = {
    run: (...args: FalArgs) => falChannels.run.invoke(sdk.run, sdk, args, {}),
    stream: (...args: FalArgs) =>
      falChannels.stream.invoke(sdk.stream, sdk, args, {}),
  };
  const streamingClients = new WeakMap<object, object>();
  const wrapStreaming = (streaming: FalClient["streaming"]) => {
    const cached = streamingClients.get(streaming);
    if (cached) return cached;
    const stream = (...args: FalArgs) =>
      falChannels.stream.invoke(streaming.stream, streaming, args, {});
    const proxy = new Proxy(streaming, {
      get(target, prop, receiver) {
        if (prop === "stream") return stream;
        return Reflect.get(target, prop, receiver);
      },
    });
    streamingClients.set(streaming, proxy);
    return proxy;
  };
  const proxy = new Proxy(sdk, {
    get(target, prop, receiver) {
      if (prop === "run" || prop === "stream") return methods[prop];
      if (prop === "streaming") return wrapStreaming(target.streaming);
      return Reflect.get(target, prop, receiver);
    },
  });
  clients.set(client, proxy);
  clients.set(proxy, proxy);
  return proxy as T;
}
