export const GLOBAL_INSTRUMENTATION_HOOKS_KEY =
  "__braintrust_invocation_hooks_v2";
export const GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION = 2;
export const GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND =
  "braintrust.global-instrumentation-hooks.registry";
export const GLOBAL_INVOCATION_HOOK_BRAND =
  "braintrust.global-instrumentation-hooks.invocation-hook";

const registryBrand = Symbol.for(GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND);
const invocationHookBrand = Symbol.for(GLOBAL_INVOCATION_HOOK_BRAND);

type GlobalInvocationTarget = (this: any, ...args: any[]) => any;

export type GlobalInvocationInterceptor<A = any> = (
  target: GlobalInvocationTarget,
  thisArg: any,
  args: any[],
  additional: A,
) => any;

export interface GlobalInvocationHook<A = any> {
  readonly hasInterceptors: boolean;
  intercept(interceptor: GlobalInvocationInterceptor<A>): () => void;
  invoke<F extends GlobalInvocationTarget>(
    target: F,
    thisArg: ThisParameterType<F>,
    args: Parameters<F>,
    additional: A,
  ): ReturnType<F>;
}

let errorReporter: ((error: unknown) => void) | undefined;

export function setGlobalHookErrorReporter(
  reporter: ((error: unknown) => void) | undefined,
): () => void {
  const previousReporter = errorReporter;
  errorReporter = reporter;
  return () => {
    if (errorReporter === reporter) {
      errorReporter = previousReporter;
    }
  };
}

function reportError(error: unknown): void {
  try {
    errorReporter?.(error);
  } catch {
    // Instrumentation diagnostics must never affect the provider call path.
  }
}

class InvocationHook<A = any> implements GlobalInvocationHook<A> {
  constructor() {
    Object.defineProperty(this, invocationHookBrand, {
      value: GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION,
    });
  }

  private interceptors: GlobalInvocationInterceptor<A>[] = [];

  get hasInterceptors(): boolean {
    return this.interceptors.length > 0;
  }

  intercept(interceptor: GlobalInvocationInterceptor<A>): () => void {
    if (typeof interceptor !== "function") {
      throw new TypeError("interceptor must be a function");
    }
    this.interceptors = [...this.interceptors, interceptor];

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      const index = this.interceptors.indexOf(interceptor);
      if (index !== -1) {
        this.interceptors = [
          ...this.interceptors.slice(0, index),
          ...this.interceptors.slice(index + 1),
        ];
      }
    };
  }

  invoke<F extends GlobalInvocationTarget>(
    target: F,
    thisArg: ThisParameterType<F>,
    args: Parameters<F>,
    additional: A,
  ): ReturnType<F> {
    const interceptors = this.interceptors;
    if (interceptors.length === 0) {
      return Reflect.apply(target, thisArg, args) as ReturnType<F>;
    }

    let next: GlobalInvocationTarget = target;
    for (let index = interceptors.length - 1; index >= 0; index -= 1) {
      const interceptor = interceptors[index];
      const downstream = next;
      next = function (this: unknown, ...nextArgs: any[]) {
        return interceptor(downstream, this, nextArgs, additional);
      };
    }
    return Reflect.apply(next, thisArg, args) as ReturnType<F>;
  }
}

type HookRegistry = Map<string, unknown>;
const inertInvocationHook: GlobalInvocationHook = Object.freeze({
  hasInterceptors: false,
  intercept: () => () => {},
  invoke<F extends GlobalInvocationTarget>(
    target: F,
    thisArg: ThisParameterType<F>,
    args: Parameters<F>,
  ): ReturnType<F> {
    return Reflect.apply(target, thisArg, args);
  },
});

function hasInvocationHookShape(
  value: unknown,
): value is GlobalInvocationHook<any> {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }

  try {
    const hook = value as GlobalInvocationHook<any>;
    return (
      (value as Record<symbol, unknown>)[invocationHookBrand] ===
        GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION &&
      typeof hook.hasInterceptors === "boolean" &&
      typeof hook.intercept === "function" &&
      typeof hook.invoke === "function"
    );
  } catch {
    return false;
  }
}

function isCompatibleHookRegistry(value: unknown): value is HookRegistry {
  try {
    return (
      value instanceof Map &&
      (value as unknown as Record<symbol, unknown>)[registryBrand] ===
        GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION
    );
  } catch {
    return false;
  }
}

function getHookRegistry(): HookRegistry | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      GLOBAL_INSTRUMENTATION_HOOKS_KEY,
    );
  } catch (error) {
    reportError(error);
    return undefined;
  }

  if (
    descriptor &&
    "value" in descriptor &&
    isCompatibleHookRegistry(descriptor.value) &&
    (descriptor.configurable || descriptor.enumerable === false)
  ) {
    if (descriptor.configurable || descriptor.writable) {
      try {
        Object.defineProperty(globalThis, GLOBAL_INSTRUMENTATION_HOOKS_KEY, {
          configurable: false,
          enumerable: false,
          value: descriptor.value,
          writable: false,
        });
      } catch (error) {
        reportError(error);
        return undefined;
      }
    }
    return descriptor.value;
  }

  if (descriptor && !descriptor.configurable) {
    reportError(new Error("Incompatible global instrumentation hook registry"));
    return undefined;
  }

  const registry: HookRegistry = new Map();
  try {
    Object.defineProperty(registry, registryBrand, {
      configurable: false,
      enumerable: false,
      value: GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION,
      writable: false,
    });
  } catch (error) {
    reportError(error);
    return undefined;
  }

  try {
    Object.defineProperty(globalThis, GLOBAL_INSTRUMENTATION_HOOKS_KEY, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    return registry;
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

export function newGlobalInvocationHook<A = any>(
  name: string,
): GlobalInvocationHook<A> {
  const registry = getHookRegistry();
  if (!registry) return inertInvocationHook;
  const existing = Map.prototype.get.call(registry, name);
  if (hasInvocationHookShape(existing)) return existing;
  if (existing !== undefined) {
    reportError(new Error(`Invalid global invocation hook: ${name}`));
  }
  const hook = new InvocationHook<A>();
  Map.prototype.set.call(registry, name, hook);
  return hook;
}
