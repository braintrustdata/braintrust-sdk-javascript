import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION,
  GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND,
  newGlobalInvocationHook,
} from "./global-instrumentation-hooks";

const hook = () => newGlobalInvocationHook(`test:${randomUUID()}`);

describe("invocation hooks", () => {
  it("shares hooks in an immutable, non-enumerable versioned registry", () => {
    const name = randomUUID();
    expect(newGlobalInvocationHook(name)).toBe(newGlobalInvocationHook(name));
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      GLOBAL_INSTRUMENTATION_HOOKS_KEY,
    )!;
    expect(descriptor).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(descriptor.value).toBeInstanceOf(Map);
    expect(
      descriptor.value[Symbol.for(GLOBAL_INSTRUMENTATION_HOOKS_REGISTRY_BRAND)],
    ).toBe(GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION);
    expect(GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION).toBe(2);
  });

  it("exposes only wrapping without requiring SDK initialization", () => {
    const invocation = hook();
    for (const method of [
      "subscribe",
      "traceInvocation",
      "tracePromise",
      "start",
      "end",
    ]) {
      expect(method in invocation).toBe(false);
    }
    const receiver = { value: 4 };
    const target = vi.fn(function (this: typeof receiver, n: number) {
      return this.value + n;
    });
    expect(invocation.invoke(target, receiver, [3], {})).toBe(7);
    expect(target).toHaveBeenCalledOnce();
  });

  it("composes in registration order and permits replacing receiver, arguments and output", () => {
    const invocation = hook();
    const order: string[] = [];
    const removeFirst = invocation.intercept((next, _, args, extra) => {
      order.push(extra.label);
      return `${next.apply({ offset: 5 }, [args[0] + 1])}:outer`;
    });
    const removeSecond = invocation.intercept((next, receiver, args) => {
      order.push("inner");
      return next.apply(receiver, [args[0] * 2]);
    });
    const target = function (this: { offset: number }, n: number) {
      order.push("target");
      return this.offset + n;
    };
    expect(
      invocation.invoke(target, { offset: 0 }, [2], { label: "outer" }),
    ).toBe("11:outer");
    expect(order).toEqual(["outer", "inner", "target"]);
    removeFirst();
    removeFirst();
    removeSecond();
    expect(invocation.hasInterceptors).toBe(false);
    expect(invocation.invoke(target, { offset: 0 }, [2], {})).toBe(2);
  });

  it("allows skipping and repeating the target and propagates interceptor failures", () => {
    const invocation = hook();
    const target = vi.fn(() => 2);
    const remove = invocation.intercept(() => 9);
    expect(invocation.invoke(target, undefined, [], {})).toBe(9);
    expect(target).not.toHaveBeenCalled();
    remove();
    const removeRepeat = invocation.intercept((next) => next() + next());
    expect(invocation.invoke(target, undefined, [], {})).toBe(4);
    expect(target).toHaveBeenCalledTimes(2);
    removeRepeat();
    const error = new Error("interceptor");
    invocation.intercept(() => {
      throw error;
    });
    expect(() => invocation.invoke(target, undefined, [], {})).toThrow(error);
    expect(target).toHaveBeenCalledTimes(2);
  });

  it("preserves exact values, Promise subclasses, streams, callbacks and thrown errors", async () => {
    class SpecialPromise extends Promise<number> {
      helper() {
        return 42;
      }
    }
    const invocation = hook();
    invocation.intercept((next, receiver, args) =>
      Reflect.apply(next, receiver, args),
    );
    const promise = new SpecialPromise((resolve) => resolve(3));
    expect(invocation.invoke(() => promise, undefined, [], {})).toBe(promise);
    expect(promise.helper()).toBe(42);
    await expect(promise).resolves.toBe(3);
    const stream = (async function* () {
      yield 1;
    })();
    expect(invocation.invoke(() => stream, undefined, [], {})).toBe(stream);
    const callback = vi.fn();
    invocation.invoke(
      (cb: typeof callback) => cb(null, 7),
      undefined,
      [callback],
      {},
    );
    expect(callback).toHaveBeenCalledWith(null, 7);
    const error = new Error("provider");
    expect(() =>
      invocation.invoke(
        () => {
          throw error;
        },
        undefined,
        [],
        {},
      ),
    ).toThrow(error);
  });

  it("lets callers provide async context without owning a store", async () => {
    const invocation = hook();
    const storage = new AsyncLocalStorage<string>();
    invocation.intercept((next, receiver, args) =>
      storage.run("wrapped", () => Reflect.apply(next, receiver, args)),
    );
    await invocation.invoke(
      async () => {
        await Promise.resolve();
        expect(storage.getStore()).toBe("wrapped");
      },
      undefined,
      [],
      {},
    );
    expect(storage.getStore()).toBeUndefined();
  });

  it("uses a stable interceptor snapshot during a call", () => {
    const invocation = hook();
    const seen: string[] = [];
    let removeSecond: () => void;
    invocation.intercept((next) => {
      removeSecond();
      return next();
    });
    removeSecond = invocation.intercept((next) => {
      seen.push("second");
      return next();
    });
    invocation.invoke(() => {}, undefined, [], {});
    invocation.invoke(() => {}, undefined, [], {});
    expect(seen).toEqual(["second"]);
  });
});
