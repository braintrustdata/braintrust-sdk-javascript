/*
 * Adapted from Node.js diagnostics_channel's TracingChannel implementation.
 * Copyright Node.js contributors. Licensed under the MIT License.
 * See licenses/node-diagnostics-channel/LICENSE.
 */

export const GLOBAL_INSTRUMENTATION_HOOKS_KEY =
  "__braintrust_instrumentation_hooks";

export interface GlobalHookAsyncLocalStorage<T> {
  enterWith(store: T): void;
  run<R>(store: T | undefined, callback: () => R): R;
  getStore(): T | undefined;
}

export type GlobalHookMessageFunction<
  M = any,
  N extends string | symbol = string,
> = (message: M, name: N) => void;

export type GlobalHookTransformFunction<M, S> = (message: M) => S;

export interface GlobalHookChannel<
  M = any,
  N extends string | symbol = string,
> {
  readonly name: N;
  readonly hasSubscribers: boolean;
  subscribe(subscription: GlobalHookMessageFunction<M, N>): void;
  unsubscribe(subscription: GlobalHookMessageFunction<M, N>): boolean;
  bindStore<T>(
    store: GlobalHookAsyncLocalStorage<T>,
    transform?: GlobalHookTransformFunction<M, T>,
  ): void;
  unbindStore<T>(store: GlobalHookAsyncLocalStorage<T>): boolean;
  publish(message: M): void;
  runStores<F extends (...args: any[]) => any>(
    message: M,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
}

export interface GlobalTracingChannelCollection<M = any> {
  readonly start?: GlobalHookChannel<M>;
  readonly end?: GlobalHookChannel<M>;
  readonly asyncStart?: GlobalHookChannel<M>;
  readonly asyncEnd?: GlobalHookChannel<M>;
  readonly error?: GlobalHookChannel<M>;
}

export interface GlobalHookHandlers<M = any> {
  start?: (context: M, name: string) => void;
  end?: (context: M, name: string) => void;
  asyncStart?: (context: M, name: string) => void;
  asyncEnd?: (context: M, name: string) => void;
  error?: (context: M, name: string) => void;
}

export interface GlobalTracingChannel<
  M = any,
> extends GlobalTracingChannelCollection<M> {
  readonly start: GlobalHookChannel<M>;
  readonly end: GlobalHookChannel<M>;
  readonly asyncStart: GlobalHookChannel<M>;
  readonly asyncEnd: GlobalHookChannel<M>;
  readonly error: GlobalHookChannel<M>;
  readonly hasSubscribers: boolean;
  subscribe(handlers: GlobalHookHandlers<M>): void;
  unsubscribe(handlers: GlobalHookHandlers<M>): boolean;
  traceSync<F extends (...args: any[]) => any>(
    fn: F,
    message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
  tracePromise<F extends (...args: any[]) => PromiseLike<any>>(
    fn: F,
    message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
  traceCallback<F extends (...args: any[]) => any>(
    fn: F,
    position?: number,
    message?: M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F>;
}

type StoreEntry<M> = [
  GlobalHookAsyncLocalStorage<unknown>,
  GlobalHookTransformFunction<M, unknown> | undefined,
];

function reportError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function defaultTransform<M>(message: M): M {
  return message;
}

function wrapStoreRun<M>(
  store: GlobalHookAsyncLocalStorage<unknown>,
  message: M,
  next: () => unknown,
  transform: GlobalHookTransformFunction<M, unknown> = defaultTransform,
): () => unknown {
  return () => {
    let context: unknown;
    try {
      context = transform(message);
    } catch (error) {
      reportError(error);
      return next();
    }
    return store.run(context, next);
  };
}

class HookChannel<
  M,
  N extends string | symbol = string,
> implements GlobalHookChannel<M, N> {
  private subscribers: GlobalHookMessageFunction<M, N>[] = [];
  private stores = new Map<
    GlobalHookAsyncLocalStorage<unknown>,
    GlobalHookTransformFunction<M, unknown> | undefined
  >();

  constructor(readonly name: N) {}

  get hasSubscribers(): boolean {
    return this.subscribers.length > 0 || this.stores.size > 0;
  }

  subscribe(subscription: GlobalHookMessageFunction<M, N>): void {
    if (typeof subscription !== "function") {
      throw new TypeError("subscription must be a function");
    }
    this.subscribers = [...this.subscribers, subscription];
  }

  unsubscribe(subscription: GlobalHookMessageFunction<M, N>): boolean {
    const index = this.subscribers.indexOf(subscription);
    if (index === -1) {
      return false;
    }
    this.subscribers = [
      ...this.subscribers.slice(0, index),
      ...this.subscribers.slice(index + 1),
    ];
    return true;
  }

  bindStore<T>(
    store: GlobalHookAsyncLocalStorage<T>,
    transform?: GlobalHookTransformFunction<M, T>,
  ): void {
    if (!store || typeof store.run !== "function") {
      throw new TypeError("store must have a run method");
    }
    this.stores.set(
      store as GlobalHookAsyncLocalStorage<unknown>,
      transform as GlobalHookTransformFunction<M, unknown> | undefined,
    );
  }

  unbindStore<T>(store: GlobalHookAsyncLocalStorage<T>): boolean {
    return this.stores.delete(store as GlobalHookAsyncLocalStorage<unknown>);
  }

  publish(message: M): void {
    const subscribers = this.subscribers;
    for (const subscriber of subscribers) {
      try {
        subscriber(message, this.name);
      } catch (error) {
        reportError(error);
      }
    }
  }

  runStores<F extends (...args: any[]) => any>(
    message: M,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    let run = () => {
      this.publish(message);
      return Reflect.apply(fn, thisArg, args);
    };
    for (const [store, transform] of this.stores.entries() as Iterable<
      StoreEntry<M>
    >) {
      run = wrapStoreRun(store, message, run, transform);
    }
    return run() as ReturnType<F>;
  }
}

const traceEvents = [
  "start",
  "end",
  "asyncStart",
  "asyncEnd",
  "error",
] as const;

class TracingHook<M> implements GlobalTracingChannel<M> {
  readonly start: GlobalHookChannel<M>;
  readonly end: GlobalHookChannel<M>;
  readonly asyncStart: GlobalHookChannel<M>;
  readonly asyncEnd: GlobalHookChannel<M>;
  readonly error: GlobalHookChannel<M>;

  constructor(nameOrChannels: string | GlobalTracingChannelCollection<M>) {
    if (typeof nameOrChannels === "string") {
      this.start = new HookChannel(`tracing:${nameOrChannels}:start`);
      this.end = new HookChannel(`tracing:${nameOrChannels}:end`);
      this.asyncStart = new HookChannel(`tracing:${nameOrChannels}:asyncStart`);
      this.asyncEnd = new HookChannel(`tracing:${nameOrChannels}:asyncEnd`);
      this.error = new HookChannel(`tracing:${nameOrChannels}:error`);
      return;
    }

    this.start = nameOrChannels.start ?? new HookChannel("tracing:start");
    this.end = nameOrChannels.end ?? new HookChannel("tracing:end");
    this.asyncStart =
      nameOrChannels.asyncStart ?? new HookChannel("tracing:asyncStart");
    this.asyncEnd =
      nameOrChannels.asyncEnd ?? new HookChannel("tracing:asyncEnd");
    this.error = nameOrChannels.error ?? new HookChannel("tracing:error");
  }

  get hasSubscribers(): boolean {
    return (
      this.start.hasSubscribers ||
      this.end.hasSubscribers ||
      this.asyncStart.hasSubscribers ||
      this.asyncEnd.hasSubscribers ||
      this.error.hasSubscribers
    );
  }

  subscribe(handlers: GlobalHookHandlers<M>): void {
    for (const eventName of traceEvents) {
      const handler = handlers[eventName];
      if (handler) {
        this[eventName].subscribe(handler);
      }
    }
  }

  unsubscribe(handlers: GlobalHookHandlers<M>): boolean {
    let done = true;
    for (const eventName of traceEvents) {
      const handler = handlers[eventName];
      if (handler && !this[eventName].unsubscribe(handler)) {
        done = false;
      }
    }
    return done;
  }

  traceSync<F extends (...args: any[]) => any>(
    fn: F,
    message: M = {} as M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    if (!this.hasSubscribers) {
      return Reflect.apply(fn, thisArg, args) as ReturnType<F>;
    }

    const context = message as Record<string, unknown>;
    return this.start.runStores(message, () => {
      try {
        const result = Reflect.apply(fn, thisArg, args);
        context.result = result;
        return result;
      } catch (error) {
        context.error = error;
        this.error.publish(message);
        throw error;
      } finally {
        this.end.publish(message);
      }
    });
  }

  tracePromise<F extends (...args: any[]) => PromiseLike<any>>(
    fn: F,
    message: M = {} as M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    if (!this.hasSubscribers) {
      return Reflect.apply(fn, thisArg, args) as ReturnType<F>;
    }

    const context = message as Record<string, unknown>;
    return this.start.runStores(message, () => {
      let ended = false;
      try {
        const result = Reflect.apply(fn, thisArg, args);
        this.end.publish(message);
        ended = true;

        if (
          !result ||
          (typeof result !== "object" && typeof result !== "function") ||
          typeof result.then !== "function"
        ) {
          context.result = result;
          this.asyncStart.publish(message);
          this.asyncEnd.publish(message);
          return result;
        }

        const resolve = (resolved: unknown) => {
          context.result = resolved;
          this.asyncStart.publish(message);
          this.asyncEnd.publish(message);
          return resolved;
        };
        const reject = (error: unknown) => {
          context.error = error;
          this.error.publish(message);
          this.asyncStart.publish(message);
          this.asyncEnd.publish(message);
          throw error;
        };

        if (result instanceof Promise && result.constructor === Promise) {
          return result.then(resolve, reject);
        }

        void result.then(resolve, (error: unknown) => {
          try {
            reject(error);
          } catch {
            // The original promise-like object is returned below. Keep the
            // instrumentation side-chain from changing its rejection behavior.
          }
        });
        return result;
      } catch (error) {
        context.error = error;
        this.error.publish(message);
        if (!ended) {
          this.end.publish(message);
        }
        throw error;
      }
    }) as ReturnType<F>;
  }

  traceCallback<F extends (...args: any[]) => any>(
    fn: F,
    position = -1,
    message: M = {} as M,
    thisArg?: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    if (!this.hasSubscribers) {
      return Reflect.apply(fn, thisArg, args);
    }

    const context = message as Record<string, unknown>;
    const callArgs =
      args.length > 0
        ? args
        : ((context.arguments as ArrayLike<unknown> | undefined) ?? args);
    const callback = Array.prototype.at.call(callArgs, position);
    if (typeof callback !== "function") {
      return Reflect.apply(fn, thisArg, args);
    }

    const { asyncStart, asyncEnd, error: errorChannel } = this;
    function wrappedCallback(this: unknown, error: unknown, result: unknown) {
      if (error) {
        context.error = error;
        errorChannel.publish(message);
      } else {
        context.result = result;
      }

      return asyncStart.runStores(message, () => {
        try {
          return Reflect.apply(callback, this, arguments);
        } finally {
          asyncEnd.publish(message);
        }
      });
    }

    Array.prototype.splice.call(callArgs, position, 1, wrappedCallback);
    return this.start.runStores(message, () => {
      try {
        return Reflect.apply(fn, thisArg, args);
      } catch (error) {
        context.error = error;
        this.error.publish(message);
        throw error;
      } finally {
        this.end.publish(message);
      }
    });
  }
}

type HookRegistry = Map<string, GlobalTracingChannel<any>>;

const fallbackRegistry: HookRegistry = new Map();

function getHookRegistry(): HookRegistry {
  const target = globalThis as Record<string, unknown>;
  const existing = target[GLOBAL_INSTRUMENTATION_HOOKS_KEY];
  if (existing instanceof Map) {
    return existing as HookRegistry;
  }
  if (existing !== undefined) {
    return fallbackRegistry;
  }

  const registry: HookRegistry = new Map();
  try {
    Object.defineProperty(globalThis, GLOBAL_INSTRUMENTATION_HOOKS_KEY, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    return registry;
  } catch {
    return fallbackRegistry;
  }
}

export function newGlobalTracingChannel<M = any>(
  nameOrChannels: string | GlobalTracingChannelCollection<M>,
): GlobalTracingChannel<M> {
  if (typeof nameOrChannels !== "string") {
    return new TracingHook(nameOrChannels);
  }

  const registry = getHookRegistry();
  const existing = registry.get(nameOrChannels);
  if (existing) {
    return existing as GlobalTracingChannel<M>;
  }

  const hook = new TracingHook<M>(nameOrChannels);
  registry.set(nameOrChannels, hook);
  return hook;
}

export function getGlobalTracingChannel<M = any>(
  name: string,
): GlobalTracingChannel<M> | undefined {
  const registry = (globalThis as Record<string, unknown>)[
    GLOBAL_INSTRUMENTATION_HOOKS_KEY
  ];
  return registry instanceof Map
    ? (registry.get(name) as GlobalTracingChannel<M> | undefined)
    : undefined;
}
