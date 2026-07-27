import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { tracingChannel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GLOBAL_INSTRUMENTATION_HOOK_BRAND,
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION,
  GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND,
  newGlobalTracingChannel,
  setGlobalHookErrorReporter,
} from "./global-instrumentation-hooks";

function uniqueChannelName(label: string): string {
  return `test:${label}:${randomUUID()}`;
}

describe("global instrumentation hooks", () => {
  let restoreErrorReporter: (() => void) | undefined;

  afterEach(() => {
    restoreErrorReporter?.();
    restoreErrorReporter = undefined;
  });

  it("installs a non-enumerable, immutable global registry", () => {
    const name = uniqueChannelName("descriptor");
    const channel = newGlobalTracingChannel(name);
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      GLOBAL_INSTRUMENTATION_HOOKS_KEY,
    );

    expect(descriptor).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(descriptor?.value).toBeInstanceOf(Map);
    expect(
      descriptor?.value[
        Symbol.for(GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND)
      ],
    ).toBe(GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION);
    expect(
      (channel as any)[Symbol.for(GLOBAL_INSTRUMENTATION_HOOK_BRAND)],
    ).toBe(GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION);
    expect(newGlobalTracingChannel(name)).toBe(channel);
    expect(Object.keys(globalThis)).not.toContain(
      GLOBAL_INSTRUMENTATION_HOOKS_KEY,
    );
  });

  it("shares subscriptions and supports complete unsubscription", () => {
    const name = uniqueChannelName("subscriptions");
    const first = newGlobalTracingChannel<Record<string, unknown>>(name);
    const second = newGlobalTracingChannel<Record<string, unknown>>(name);
    const events: string[] = [];
    const handlers = {
      start: () => events.push("start"),
      end: () => events.push("end"),
    };

    expect(first).toBe(second);
    first.subscribe(handlers);
    expect(second.hasSubscribers).toBe(true);
    expect(second.traceSync(() => 42, {})).toBe(42);
    expect(events).toEqual(["start", "end"]);
    expect(second.unsubscribe(handlers)).toBe(true);
    expect(first.hasSubscribers).toBe(false);
    expect(second.unsubscribe(handlers)).toBe(false);
  });

  it("does not publish legacy diagnostics-channel events", () => {
    const name = uniqueChannelName("hard-cutover");
    const diagnostics = tracingChannel(name);
    const diagnosticsEvents: unknown[] = [];
    const diagnosticsHandler = (message: unknown) =>
      diagnosticsEvents.push(message);
    diagnostics.start.subscribe(diagnosticsHandler);

    const hook = newGlobalTracingChannel<Record<string, unknown>>(name);
    const hookEvents: unknown[] = [];
    hook.subscribe({ start: (message) => hookEvents.push(message) });
    hook.traceSync(() => "result", {});

    expect(hookEvents).toHaveLength(1);
    expect(diagnosticsEvents).toHaveLength(0);
    diagnostics.start.unsubscribe(diagnosticsHandler);
  });

  it("mirrors sync lifecycle ordering and rethrows errors", () => {
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("sync"),
    );
    const lifecycle: string[] = [];
    const contexts: Record<string, unknown>[] = [];
    channel.subscribe({
      start: (context) => {
        lifecycle.push("start");
        contexts.push(context);
      },
      end: (context) => {
        lifecycle.push("end");
        contexts.push(context);
      },
      error: (context) => {
        lifecycle.push("error");
        contexts.push(context);
      },
    });

    const successContext: Record<string, unknown> = {};
    expect(channel.traceSync(() => "result", successContext)).toBe("result");
    expect(successContext.result).toBe("result");
    expect(lifecycle).toEqual(["start", "end"]);
    expect(contexts).toEqual([successContext, successContext]);

    lifecycle.length = 0;
    contexts.length = 0;
    const error = new Error("boom");
    const errorContext: Record<string, unknown> = {};
    expect(() =>
      channel.traceSync(() => {
        throw error;
      }, errorContext),
    ).toThrow(error);
    expect(errorContext.error).toBe(error);
    expect(lifecycle).toEqual(["start", "error", "end"]);
    expect(contexts).toEqual([errorContext, errorContext, errorContext]);
  });

  it("mirrors promise lifecycle ordering for resolution and rejection", async () => {
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("promise"),
    );
    const lifecycle: string[] = [];
    channel.subscribe({
      start: () => lifecycle.push("start"),
      end: () => lifecycle.push("end"),
      asyncStart: () => lifecycle.push("asyncStart"),
      asyncEnd: () => lifecycle.push("asyncEnd"),
      error: () => lifecycle.push("error"),
    });

    const successContext: Record<string, unknown> = {};
    await expect(
      channel.tracePromise(async () => "result", successContext),
    ).resolves.toBe("result");
    expect(successContext.result).toBe("result");
    expect(lifecycle).toEqual(["start", "end", "asyncStart", "asyncEnd"]);

    lifecycle.length = 0;
    const error = new Error("rejected");
    const errorContext: Record<string, unknown> = {};
    await expect(
      channel.tracePromise(async () => {
        throw error;
      }, errorContext),
    ).rejects.toBe(error);
    expect(errorContext.error).toBe(error);
    expect(lifecycle).toEqual([
      "start",
      "end",
      "error",
      "asyncStart",
      "asyncEnd",
    ]);
  });

  it("preserves promise subclasses and non-Promise return values", async () => {
    class HelperPromise<T> extends Promise<T> {
      withResponse(): Promise<{ data: T }> {
        return this.then((data) => ({ data }));
      }
    }

    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("promise-subclass"),
    );
    const lifecycle: string[] = [];
    channel.subscribe({
      end: () => lifecycle.push("end"),
      asyncStart: () => lifecycle.push("asyncStart"),
      asyncEnd: () => lifecycle.push("asyncEnd"),
    });
    const original = new HelperPromise<string>((resolve) => resolve("ok"));
    const traced = channel.tracePromise(() => original, {});

    expect(traced).toBe(original);
    await expect(traced.withResponse()).resolves.toEqual({ data: "ok" });
    lifecycle.length = 0;

    const nonPromise = channel.tracePromise(
      (() => 42) as unknown as () => PromiseLike<number>,
      {},
    );
    expect(nonPromise).toBe(42);
    expect(lifecycle).toEqual(["end", "asyncStart", "asyncEnd"]);
  });

  it("returns unusual thenables unchanged when inspecting them fails", () => {
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("hostile-thenable"),
    );
    const reportedErrors: unknown[] = [];
    const lifecycle: string[] = [];
    restoreErrorReporter = setGlobalHookErrorReporter((error) =>
      reportedErrors.push(error),
    );
    channel.subscribe({
      start: () => lifecycle.push("start"),
      end: () => lifecycle.push("end"),
      asyncStart: () => lifecycle.push("asyncStart"),
      asyncEnd: () => lifecycle.push("asyncEnd"),
      error: () => lifecycle.push("error"),
    });

    const getterError = new Error("then getter failed");
    const throwingGetter = Object.defineProperty({}, "then", {
      get() {
        throw getterError;
      },
    }) as PromiseLike<unknown>;
    const getterContext: Record<string, unknown> = {};
    expect(channel.tracePromise(() => throwingGetter, getterContext)).toBe(
      throwingGetter,
    );
    expect(getterContext.result).toBe(throwingGetter);

    const constructorError = new Error("constructor getter failed");
    const throwingConstructor = Object.defineProperty(
      Object.create(Promise.prototype),
      "constructor",
      {
        get() {
          throw constructorError;
        },
      },
    ) as PromiseLike<unknown>;
    const constructorContext: Record<string, unknown> = {};
    expect(
      channel.tracePromise(() => throwingConstructor, constructorContext),
    ).toBe(throwingConstructor);
    expect(constructorContext.result).toBe(throwingConstructor);

    const invocationError = new Error("then invocation failed");
    const throwingThen = {
      then() {
        throw invocationError;
      },
    } as PromiseLike<unknown>;
    const invocationContext: Record<string, unknown> = {};
    expect(channel.tracePromise(() => throwingThen, invocationContext)).toBe(
      throwingThen,
    );
    expect(invocationContext.result).toBe(throwingThen);

    expect(lifecycle).toEqual([
      "start",
      "end",
      "asyncStart",
      "asyncEnd",
      "start",
      "end",
      "asyncStart",
      "asyncEnd",
      "start",
      "end",
      "asyncStart",
      "asyncEnd",
    ]);
    expect(reportedErrors).toEqual([
      getterError,
      constructorError,
      invocationError,
    ]);
  });

  it("contains subscriber and store failures without repeating provider calls", () => {
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("instrumentation-errors"),
    );
    const reportedErrors: unknown[] = [];
    restoreErrorReporter = setGlobalHookErrorReporter((error) =>
      reportedErrors.push(error),
    );

    const subscriberError = new Error("subscriber failed");
    channel.subscribe({
      start: () => {
        throw subscriberError;
      },
    });

    const storeError = new Error("store failed");
    const brokenStore = {
      enterWith() {},
      getStore() {
        return undefined;
      },
      run<T>(_store: unknown, callback: () => T): T {
        callback();
        throw storeError;
      },
    };
    channel.start.bindStore(brokenStore);

    const provider = vi.fn(() => "result");
    expect(channel.traceSync(provider, {})).toBe("result");
    expect(provider).toHaveBeenCalledOnce();
    expect(reportedErrors).toContain(subscriberError);
    expect(reportedErrors).toContain(storeError);
  });

  it("does not repeat provider calls when a store invokes its callback late", () => {
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("late-store"),
    );
    const reportedErrors: unknown[] = [];
    restoreErrorReporter = setGlobalHookErrorReporter((error) =>
      reportedErrors.push(error),
    );

    let callback: (() => unknown) | undefined;
    channel.start.bindStore({
      enterWith() {},
      getStore() {
        return undefined;
      },
      run<T>(_store: unknown, next: () => T): T {
        callback = next;
        return undefined as T;
      },
    });

    const provider = vi.fn(() => "result");
    expect(channel.traceSync(provider, {})).toBe("result");
    expect(provider).toHaveBeenCalledOnce();
    expect(callback?.()).toBe("result");
    expect(provider).toHaveBeenCalledOnce();
    expect(reportedErrors.map(String)).toEqual([
      "Error: Instrumentation store did not invoke its callback",
      "Error: Instrumentation store invoked its callback more than once",
    ]);
  });

  it("replaces malformed entries without executing them", () => {
    const name = uniqueChannelName("malformed-entry");
    const registry = Object.getOwnPropertyDescriptor(
      globalThis,
      GLOBAL_INSTRUMENTATION_HOOKS_KEY,
    )?.value as Map<string, unknown>;
    registry.set(name, { hasSubscribers: true });

    const reportedErrors: unknown[] = [];
    restoreErrorReporter = setGlobalHookErrorReporter((error) =>
      reportedErrors.push(error),
    );
    const channel = newGlobalTracingChannel(name);
    const subscriber = vi.fn();
    channel.subscribe({ start: subscriber });
    const provider = vi.fn(() => "result");

    expect(channel.traceSync(provider, {})).toBe("result");
    expect(provider).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledOnce();
    expect(reportedErrors.map(String)).toEqual([
      `Error: Invalid global instrumentation hook: ${name}`,
    ]);
  });

  it("replaces unbranded hook-shaped entries without mutating them", () => {
    const name = uniqueChannelName("unbranded-entry");
    const registry = Object.getOwnPropertyDescriptor(
      globalThis,
      GLOBAL_INSTRUMENTATION_HOOKS_KEY,
    )?.value as Map<string, unknown>;
    const foreignChannel = {
      bindStore: vi.fn(),
      hasSubscribers: false,
      publish: vi.fn(),
      runStores: vi.fn(),
      subscribe: vi.fn(),
      unbindStore: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const foreignHook = {
      asyncEnd: foreignChannel,
      asyncStart: foreignChannel,
      end: foreignChannel,
      error: foreignChannel,
      hasSubscribers: false,
      start: foreignChannel,
      subscribe: vi.fn(),
      traceCallback: vi.fn(),
      tracePromise: vi.fn(),
      traceSync: vi.fn(),
      unsubscribe: vi.fn(),
    };
    registry.set(name, foreignHook);

    const channel = newGlobalTracingChannel(name);

    expect(channel).not.toBe(foreignHook);
    expect(registry.get(name)).toBe(channel);
    expect(
      (foreignHook as Record<symbol, unknown>)[
        Symbol.for(GLOBAL_INSTRUMENTATION_HOOK_BRAND)
      ],
    ).toBeUndefined();
  });

  it("wraps callbacks without changing arguments or receiver semantics", async () => {
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("callback"),
    );
    const lifecycle: string[] = [];
    channel.subscribe({
      start: () => lifecycle.push("start"),
      end: () => lifecycle.push("end"),
      asyncStart: () => lifecycle.push("asyncStart"),
      asyncEnd: () => lifecycle.push("asyncEnd"),
    });

    const receiver = { label: "receiver" };
    const result = await new Promise<string>((resolve) => {
      channel.traceCallback(
        function (this: typeof receiver, value: string, callback: Function) {
          expect(this).toBe(receiver);
          callback.call(this, null, value);
          return "immediate";
        },
        1,
        {},
        receiver,
        "done",
        function (this: typeof receiver, error: unknown, value: string) {
          expect(this).toBe(receiver);
          expect(error).toBeNull();
          resolve(value);
        },
      );
    });

    expect(result).toBe("done");
    expect(lifecycle).toEqual(["start", "asyncStart", "asyncEnd", "end"]);
  });

  it("runs traced functions inside bound stores", () => {
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      uniqueChannelName("stores"),
    );
    const storage = new AsyncLocalStorage<string>();
    channel.start.bindStore(storage, () => "bound");

    expect(channel.hasSubscribers).toBe(true);
    expect(channel.traceSync(() => storage.getStore(), {})).toBe("bound");
    expect(channel.start.unbindStore(storage)).toBe(true);
    expect(channel.hasSubscribers).toBe(false);
  });
});
