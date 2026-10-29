import { createIsomorph, type Common } from "../isomorph-base";

// This is copied from next.js. It seems they define AsyncLocalStorage in the edge
// environment, even though it's not defined in the browser.
import type { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";

declare global {
  var AsyncLocalStorage: typeof NodeAsyncLocalStorage;
  var __BRAINTRUST_BROWSER_PKG__: boolean | undefined;
}

/**
 * Configure the isomorph for browser environments.
 */
export function createBrowserIsomorph(): Common {
  const iso = createIsomorph();

  iso.buildType = "browser";

  const fallbackAsyncLocalStorage = iso.newAsyncLocalStorage;
  iso.newAsyncLocalStorage = <T>() =>
    typeof AsyncLocalStorage !== "undefined"
      ? new AsyncLocalStorage<T>()
      : fallbackAsyncLocalStorage<T>();

  iso.getEnv = (name: string) => {
    if (typeof process === "undefined" || typeof process.env === "undefined") {
      return undefined;
    }
    return process.env[name];
  };
  iso.getBraintrustApiKey = async () => {
    const value = iso.getEnv("BRAINTRUST_API_KEY");
    return value?.trim() ? value : undefined;
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

  return iso;
}
