import { tracingChannel } from "dc-browser";
import iso from "../isomorph";
import { _internalSetInitialState } from "../logger";
import { registry } from "../instrumentation/registry";
import { patchTracingChannel } from "../auto-instrumentations/patch-tracing-channel";

// This is copied from next.js. It seems they define AsyncLocalStorage in the edge
// environment, even though it's not defined in the browser.
import type { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";

declare global {
  var AsyncLocalStorage: typeof NodeAsyncLocalStorage;
  var __BRAINTRUST_BROWSER_PKG__: boolean | undefined;
}

let browserConfigured = false;

/**
 * Configure the isomorph for browser environments.
 */
export function configureBrowser(): void {
  if (browserConfigured) {
    return;
  }

  iso.buildType = "browser";

  // Try to use global AsyncLocalStorage (edge runtime like Next.js)
  try {
    if (typeof AsyncLocalStorage !== "undefined") {
      iso.newAsyncLocalStorage = <T>() => new AsyncLocalStorage<T>();
    }
  } catch {
    // Ignore
  }

  iso.newTracingChannel = <_M = any>(nameOrChannels: string | object) =>
    tracingChannel(nameOrChannels as any) as any;

  // Patch TracingChannel.prototype.tracePromise to handle APIPromise and other
  // Promise subclasses (mirrors the fix in hook.mts for the --import loader path).
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

  // Enable auto-instrumentation
  registry.enable();

  browserConfigured = true;
}
