import { createIsomorph, type Common } from "../isomorph-base";
import { resolveRuntimeAsyncLocalStorage } from "../runtime-async-local-storage";

/**
 * Configure the isomorph for edge-light runtime environments (Vercel Edge, Next.js Edge, etc.).
 */
export function createEdgeLightIsomorph(): Common {
  const iso = createIsomorph();

  iso.buildType = "edge-light";

  const fallbackAsyncLocalStorage = iso.newAsyncLocalStorage;
  iso.newAsyncLocalStorage = <T>() => {
    const RuntimeAsyncLocalStorage = resolveRuntimeAsyncLocalStorage();
    return RuntimeAsyncLocalStorage
      ? new RuntimeAsyncLocalStorage<T>()
      : fallbackAsyncLocalStorage<T>();
  };

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
