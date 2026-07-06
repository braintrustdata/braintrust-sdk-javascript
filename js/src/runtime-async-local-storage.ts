import type { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";

type RuntimeAsyncLocalStorageConstructor = new <
  T,
>() => NodeAsyncLocalStorage<T>;

function isAsyncLocalStorageConstructor(
  candidate: unknown,
): candidate is RuntimeAsyncLocalStorageConstructor {
  return typeof candidate === "function";
}

export function resolveRuntimeAsyncLocalStorage():
  | RuntimeAsyncLocalStorageConstructor
  | undefined {
  try {
    const globalAsyncLocalStorage: unknown = Reflect.get(
      globalThis,
      "AsyncLocalStorage",
    );

    if (isAsyncLocalStorageConstructor(globalAsyncLocalStorage)) {
      return globalAsyncLocalStorage;
    }

    if (typeof process === "undefined") {
      return undefined;
    }

    const getBuiltinModule: unknown = Reflect.get(process, "getBuiltinModule");

    if (typeof getBuiltinModule !== "function") {
      return undefined;
    }

    const asyncHooksModule = getBuiltinModule("node:async_hooks");

    if (typeof asyncHooksModule !== "object" || asyncHooksModule === null) {
      return undefined;
    }

    if (!("AsyncLocalStorage" in asyncHooksModule)) {
      return undefined;
    }

    const { AsyncLocalStorage: runtimeAsyncLocalStorage } = asyncHooksModule;

    return isAsyncLocalStorageConstructor(runtimeAsyncLocalStorage)
      ? runtimeAsyncLocalStorage
      : undefined;
  } catch {
    return undefined;
  }
}
