import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { LazyValue, runCatchFinally } from "./util";

function createForeignPromise(subclass = false) {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const promise: Promise<string> = runInNewContext(
    `${subclass ? "class ForeignPromise extends Promise {}" : ""}
    new ${subclass ? "ForeignPromise" : "Promise"}((resolve, reject) => capture(resolve, reject))`,
    {
      capture: (
        resolvePromise: (value: string) => void,
        rejectPromise: (reason: Error) => void,
      ) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      },
    },
  );
  return { promise, resolve, reject };
}

test("runCatchFinally waits for a promise from another realm", async () => {
  const { promise, resolve } = createForeignPromise();
  expect(promise).not.toBeInstanceOf(Promise);
  const events: string[] = [];
  const result = runCatchFinally(
    () => promise,
    (error) => {
      throw error;
    },
    () => events.push("finally"),
  );

  expect(events).toEqual([]);
  resolve("done");
  await expect(result).resolves.toBe("done");
  expect(events).toEqual(["finally"]);
});

test("runCatchFinally catches rejection from another realm before cleanup", async () => {
  const { promise, reject } = createForeignPromise();
  const error = new Error("foreign rejection");
  const events: string[] = [];
  const result = runCatchFinally(
    () => promise,
    (caught) => {
      expect(caught).toBe(error);
      events.push("catch");
      throw caught;
    },
    () => events.push("finally"),
  );

  reject(error);
  await expect(result).rejects.toBe(error);
  expect(events).toEqual(["catch", "finally"]);
});

test("runCatchFinally preserves foreign Promise subclass chaining", async () => {
  const { promise, resolve } = createForeignPromise(true);
  const events: string[] = [];
  const result = runCatchFinally(
    () => promise,
    (error) => {
      throw error;
    },
    () => events.push("finally"),
  );

  expect(result.constructor).toBe(promise.constructor);
  expect(events).toEqual([]);
  resolve("foreign subclass");
  await expect(result).resolves.toBe("foreign subclass");
  expect(events).toEqual(["finally"]);
});

test("runCatchFinally preserves native Promise subclass chaining", async () => {
  class SpecializedPromise<T> extends Promise<T> {}
  const promise = new SpecializedPromise<string>((resolve) =>
    resolve("native subclass"),
  );
  const result = runCatchFinally(
    () => promise,
    (error) => {
      throw error;
    },
    () => {},
  );

  expect(result).toBeInstanceOf(SpecializedPromise);
  await expect(result).resolves.toBe("native subclass");
});

test("runCatchFinally waits for a thenable without catch or finally methods", async () => {
  const promise = Promise.resolve("thenable result");
  const events: string[] = [];
  const result = runCatchFinally(
    () => ({ then: promise.then.bind(promise) }),
    (error) => {
      throw error;
    },
    () => events.push("finally"),
  );

  expect(events).toEqual([]);
  expect(await result).toBe("thenable result");
  expect(events).toEqual(["finally"]);
});

test("runCatchFinally preserves synchronous return and error handling", () => {
  const events: string[] = [];
  expect(
    runCatchFinally(
      () => 42,
      () => 0,
      () => events.push("finally"),
    ),
  ).toBe(42);
  expect(events).toEqual(["finally"]);

  expect(
    runCatchFinally(
      (): number => {
        throw new Error("sync failure");
      },
      () => {
        events.push("catch");
        return 17;
      },
      () => events.push("finally"),
    ),
  ).toBe(17);
  expect(events).toEqual(["finally", "catch", "finally"]);
});

test("LazyValue evaluates exactly once", async () => {
  let callCount = 0;
  const lazy = new LazyValue(async () => {
    callCount++;
    return "test";
  });

  expect(callCount).toBe(0);
  expect(lazy.hasSucceeded).toBe(false);

  const promise1 = lazy.get();
  const promise2 = lazy.get();

  expect(callCount).toBe(1);
  expect(lazy.hasSucceeded).toBe(false);

  await promise1;
  await promise2;

  expect(callCount).toBe(1);
  expect(lazy.hasSucceeded).toBe(true);
});

test("LazyValue hasSucceeded only set after successful completion", async () => {
  const lazy = new LazyValue(async () => {
    throw new Error("test error");
  });

  expect(lazy.hasSucceeded).toBe(false);

  try {
    await lazy.get();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    expect((e as Error).message).toBe("test error");
  }

  expect(lazy.hasSucceeded).toBe(false);
});

test("LazyValue caches successful result", async () => {
  const lazy = new LazyValue(async () => "test value");

  const result1 = await lazy.get();
  const result2 = await lazy.get();

  expect(result1).toBe("test value");
  expect(result2).toBe("test value");
  expect(lazy.hasSucceeded).toBe(true);
});

test("LazyValue GetSync returns correct state and value", async () => {
  const lazy = new LazyValue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "test value";
  });

  // Initial state - uninitialized
  const initial = lazy.getSync();
  expect(initial.resolved).toBe(false);
  expect(initial.value).toBeUndefined();

  // Start computation
  const promise = lazy.get();

  // In progress state
  const inProgress = lazy.getSync();
  expect(inProgress.resolved).toBe(false);
  expect(inProgress.value).toBeUndefined();

  // Wait for completion
  await promise;

  // Completed state
  const completed = lazy.getSync();
  expect(completed.resolved).toBe(true);
  expect(completed.value).toBe("test value");
});
