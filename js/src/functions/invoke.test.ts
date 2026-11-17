import { describe, expect, test, beforeEach, afterEach } from "vite-plus/test";
import { initFunction } from "./invoke";
import { _internalGetGlobalState } from "../logger/core";
import { _exportsForTestingOnly } from "../logger/testing";
import { configureNode } from "../node/config";

describe("initFunction", () => {
  beforeEach(() => {
    configureNode();
    _exportsForTestingOnly.setInitialTestState();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("should disable span cache when called", async () => {
    const state = _internalGetGlobalState();

    // Cache should be disabled by default (it's only enabled during evals)
    expect(state.spanCache.disabled).toBe(true);

    // Call initFunction
    initFunction({
      projectName: "test-project",
      slug: "test-function",
    });

    // Cache should still be disabled (initFunction also explicitly disables it)
    expect(state.spanCache.disabled).toBe(true);
  });

  test("should return a function with correct name", () => {
    const fn = initFunction({
      projectName: "my-project",
      slug: "my-scorer",
      version: "v1",
    });

    expect(fn.name).toBe("initFunction-my-project-my-scorer-v1");
  });

  test("should use 'latest' in name when version not specified", () => {
    const fn = initFunction({
      projectName: "my-project",
      slug: "my-scorer",
    });

    expect(fn.name).toBe("initFunction-my-project-my-scorer-latest");
  });
});

describe("registerOtelFlush", () => {
  beforeEach(() => {
    _exportsForTestingOnly.setInitialTestState();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("should register OTEL flush callback", async () => {
    const { registerOtelFlush } = await import("../logger/core");
    const state = _internalGetGlobalState();

    let flushed = false;
    const mockFlush = async () => {
      flushed = true;
    };

    registerOtelFlush(mockFlush);

    // Calling flushOtel should invoke the registered callback
    await state.flushOtel();

    expect(flushed).toBe(true);
  });

  test("flushOtel should be no-op when no callback registered", async () => {
    const state = _internalGetGlobalState();

    // Should not throw
    await state.flushOtel();
  });
});

test("OTel flush registrations coexist and can be removed independently", async () => {
  _exportsForTestingOnly.setInitialTestState();
  const { registerOtelFlush } = await import("../logger/core");
  const state = _internalGetGlobalState();
  const calls: string[] = [];
  const removeFirst = registerOtelFlush(async () => {
    calls.push("first");
  });
  const removeSecond = registerOtelFlush(async () => {
    calls.push("second");
  });
  try {
    await state.flushOtel();
    expect(calls).toEqual(["first", "second"]);
    removeFirst();
    removeFirst();
    calls.length = 0;
    await state.flushOtel();
    expect(calls).toEqual(["second"]);
  } finally {
    removeFirst();
    removeSecond();
  }
});

test("a failed OTel flush still starts every registered callback", async () => {
  _exportsForTestingOnly.setInitialTestState();
  const { registerOtelFlush } = await import("../logger/core");
  const state = _internalGetGlobalState();
  const error = new Error("flush failed");
  let secondFlushed = false;
  const removeFirst = registerOtelFlush(() => {
    throw error;
  });
  const removeSecond = registerOtelFlush(async () => {
    secondFlushed = true;
  });
  try {
    await expect(state.flushOtel()).rejects.toBe(error);
    expect(secondFlushed).toBe(true);
  } finally {
    removeFirst();
    removeSecond();
  }
});
