import iso from "../isomorph";
import type {
  IsoTracingChannel,
  IsoTracingChannelCollection,
} from "../isomorph";
import { _internalSetInitialState } from "../logger";
import { resolveRuntimeAsyncLocalStorage } from "../runtime-async-local-storage";
import { tracingChannel } from "dc-browser";
import { patchTracingChannel } from "../auto-instrumentations/patch-tracing-channel";
import { registry } from "../instrumentation/registry";

let workerdConfigured = false;

/**
 * Configure the isomorph for Cloudflare Workers (workerd) runtime.
 */
export function configureWorkerd(): void {
  if (workerdConfigured) {
    return;
  }

  iso.buildType = "workerd";

  const runtimeAsyncLocalStorage = resolveRuntimeAsyncLocalStorage();

  if (runtimeAsyncLocalStorage) {
    iso.newAsyncLocalStorage = <T>() => new runtimeAsyncLocalStorage<T>();
  }

  iso.newTracingChannel = <M = unknown>(
    nameOrChannels: string | IsoTracingChannelCollection<M>,
  ) =>
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    tracingChannel(nameOrChannels as string | object) as IsoTracingChannel<M>;
  patchTracingChannel(tracingChannel);

  iso.getEnv = (name: string) => {
    if (typeof process === "undefined" || typeof process.env === "undefined") {
      return undefined;
    }
    return process.env[name];
  };

  iso.hash = (data: string): string => {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    const hashHex = (hash >>> 0).toString(16).padStart(8, "0");
    return hashHex.repeat(8).substring(0, 64);
  };

  _internalSetInitialState();
  registry.enable();
  workerdConfigured = true;
}
