/**
 * Regression tests for patchTracingChannel.
 *
 * The bug: Node.js diagnostics_channel's tracePromise calls PromisePrototypeThen
 * (the original, unoverridden Promise.prototype.then) on the return value. This uses
 * the Symbol.species protocol to create the result promise — it calls
 * new SubClass(resolve, reject) — which breaks for Promise subclasses that don't
 * accept a standard (resolve, reject) executor as their first argument (e.g.,
 * Anthropic's APIPromise, which takes a responsePromise).
 *
 * The fix: call result.then(resolve, reject) directly, which invokes whatever .then()
 * override the subclass provides (typically a safe version that delegates to an inner
 * native Promise, avoiding the species protocol entirely).
 */

import { describe, it, expect } from "vitest";
import { patchTracingChannel } from "./patch-tracing-channel";

/**
 * Creates a fresh TracingChannel-like class with the ORIGINAL broken tracePromise
 * behavior, simulating Node.js diagnostics_channel before the patch is applied.
 *
 * The key difference from the patched version: it calls
 * `Promise.prototype.then.call(result, ...)` (equivalent to Node.js's internal
 * PromisePrototypeThen), which triggers Symbol.species on Promise subclasses.
 */
function makeUnpatchedTracingChannel() {
  class FakeChannel {
    readonly hasSubscribers = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publish(_msg: any): void {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runStores(_msg: any, fn: () => any): any {
      return fn();
    }
  }

  class FakeTracingChannel {
    start = new FakeChannel();
    end = new FakeChannel();
    asyncStart = new FakeChannel();
    asyncEnd = new FakeChannel();
    error = new FakeChannel();

    tracePromise(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn: (...args: any[]) => any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      context: Record<string, any> = {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thisArg: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...args: any[]
    ): Promise<unknown> {
      const { start, end, asyncStart, asyncEnd, error } = this;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function reject(err: any) {
        context.error = err;
        error.publish(context);
        asyncStart.publish(context);
        asyncEnd.publish(context);
        return Promise.reject(err);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function resolve(result: any) {
        context.result = result;
        asyncStart.publish(context);
        asyncEnd.publish(context);
        return result;
      }

      start.publish(context);

      try {
        const result = Reflect.apply(fn, thisArg, args);

        // BROKEN: calls original Promise.prototype.then directly, equivalent to
        // Node.js's internal PromisePrototypeThen(result, resolve, reject).
        // This triggers Symbol.species on Promise subclasses, calling
        // new SubClass(resolve, reject) — which breaks for non-standard constructors.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (Promise.prototype.then as any).call(
          result as Promise<unknown>,
          resolve,
          reject,
        );
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    }
  }

  return FakeTracingChannel;
}

/**
 * Minimal reproduction of Anthropic's APIPromise pattern:
 * - Non-standard constructor: takes a responsePromise, not a (resolve, reject) executor
 * - Overrides .then() to delegate to an inner native Promise (avoiding species protocol)
 * - Sets Symbol.species to a class that throws, reproducing the exact error
 *
 * When PromisePrototypeThen(apiPromise, resolve, reject) is called (the original .then),
 * it uses Symbol.species to create the result promise: new FailingSpecies(resolve, reject)
 * which throws "Promise resolve or reject function is not callable".
 *
 * When apiPromise.then(resolve, reject) is called (the patched behavior), it invokes
 * the safe .then() override which delegates to the inner native promise, bypassing
 * Symbol.species entirely.
 */
class MockAPIPromise<T> extends Promise<T> {
  readonly #innerPromise: Promise<T>;

  constructor(responsePromise: Promise<T>) {
    let res!: (value: T | PromiseLike<T>) => void;
    super((resolve) => {
      res = resolve;
    });
    this.#innerPromise = Promise.resolve(responsePromise);
    this.#innerPromise.then(res);
  }

  // Safe override: delegates to the inner native Promise instead of `this`.
  // Calling .then() on a native Promise uses native Promise as the species,
  // so it never tries to call new MockAPIPromise(resolve, reject).
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#innerPromise.then(onfulfilled, onrejected);
  }

  async withResponse() {
    return {
      data: await this.#innerPromise,
      response: { ok: true },
    };
  }

  // Symbol.species returns a class that throws, reproducing the exact error seen
  // when Node.js's PromisePrototypeThen tries to construct the result promise.
  static override get [Symbol.species](): PromiseConstructor {
    return class {
      constructor() {
        throw new TypeError(
          "Promise resolve or reject function is not callable",
        );
      }
    } as unknown as PromiseConstructor;
  }
}

describe("patchTracingChannel", () => {
  it("unpatched tracePromise throws when given a Promise subclass with incompatible Symbol.species", () => {
    // This reproduces the error reported with Anthropic's APIPromise + Node.js bundler path.
    const FakeTCClass = makeUnpatchedTracingChannel();
    const channel = new FakeTCClass();
    const apiPromise = new MockAPIPromise(Promise.resolve("hello"));

    // The unpatched tracePromise calls Promise.prototype.then.call(result, ...) which
    // uses Symbol.species to create the result promise, throwing synchronously.
    expect(() => channel.tracePromise(() => apiPromise, {}, null)).toThrow(
      "Promise resolve or reject function is not callable",
    );
  });

  it("patched tracePromise correctly handles Promise subclasses with non-standard Symbol.species", async () => {
    const FakeTCClass = makeUnpatchedTracingChannel();
    const channel = new FakeTCClass();

    // Apply the patch — replaces FakeTCClass.prototype.tracePromise with the fixed version
    patchTracingChannel(() => channel);

    const context: Record<string, unknown> = {};
    const apiPromise = new MockAPIPromise(Promise.resolve("hello"));

    // The patched tracePromise calls result.then(resolve, reject) directly, which
    // invokes our safe .then() override that avoids the species protocol.
    const result = await channel.tracePromise(() => apiPromise, context, null);

    expect(result).toBe("hello");
    expect(context.result).toBe("hello");
  });

  it("patched tracePromise preserves helper methods on promise subclasses", async () => {
    const FakeTCClass = makeUnpatchedTracingChannel();
    const channel = new FakeTCClass();
    patchTracingChannel(() => channel);

    const apiPromise = new MockAPIPromise(Promise.resolve("hello"));
    const traced = channel.tracePromise(() => apiPromise, {}, null);
    const withResponse = await traced.withResponse();

    expect(traced).toBe(apiPromise);
    expect(withResponse.data).toBe("hello");
    expect(withResponse.response.ok).toBe(true);
  });

  it("patched tracePromise correctly handles plain async functions", async () => {
    const FakeTCClass = makeUnpatchedTracingChannel();
    const channel = new FakeTCClass();
    patchTracingChannel(() => channel);

    const context: Record<string, unknown> = {};
    const result = await channel.tracePromise(
      async () => "world",
      context,
      null,
    );

    expect(result).toBe("world");
    expect(context.result).toBe("world");
  });

  it("patched tracePromise propagates rejections and sets context.error", async () => {
    const FakeTCClass = makeUnpatchedTracingChannel();
    const channel = new FakeTCClass();
    patchTracingChannel(() => channel);

    const context: Record<string, unknown> = {};
    const err = new Error("api error");

    await expect(
      channel.tracePromise(
        async () => {
          throw err;
        },
        context,
        null,
      ),
    ).rejects.toBe(err);

    expect(context.error).toBe(err);
  });

  it("is idempotent — applying the patch twice produces correct behavior", async () => {
    const FakeTCClass = makeUnpatchedTracingChannel();
    const channel = new FakeTCClass();

    patchTracingChannel(() => channel);
    patchTracingChannel(() => channel);

    const context: Record<string, unknown> = {};
    const apiPromise = new MockAPIPromise(Promise.resolve(99));
    const result = await channel.tracePromise(() => apiPromise, context, null);

    expect(result).toBe(99);
    expect(context.result).toBe(99);
  });
});
