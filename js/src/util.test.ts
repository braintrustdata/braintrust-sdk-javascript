import { expect, test } from "vitest";
import { isPlainObject, LazyValue } from "./util";

test("isPlainObject recognizes records without accepting class instances", () => {
  expect(isPlainObject({ value: 1 })).toBe(true);
  expect(isPlainObject(Object.create(null))).toBe(true);
  expect(isPlainObject([])).toBe(false);
  expect(isPlainObject(new Date())).toBe(false);
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
