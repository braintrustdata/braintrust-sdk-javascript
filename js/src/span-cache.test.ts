import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import { SpanCache } from "./span-cache";
import { configureNode } from "./node/config";

describe("SpanCache (disk-based)", () => {
  let cache: SpanCache;

  beforeAll(() => {
    configureNode();
  });

  beforeEach(() => {
    cache = new SpanCache();
    cache.start(); // Start for testing (cache is disabled by default)
  });

  afterEach(() => {
    // Clean up temp file after each test
    cache.stop();
    cache.dispose();
  });

  describe("write and read", () => {
    test("should store and retrieve spans by rootSpanId", () => {
      const rootSpanId = "root-123";
      const span1 = {
        span_id: "span-1",
        input: { text: "hello" },
        output: { response: "world" },
      };
      const span2 = {
        span_id: "span-2",
        input: { text: "foo" },
        output: { response: "bar" },
      };

      cache.queueWrite(rootSpanId, span1.span_id, span1);
      cache.queueWrite(rootSpanId, span2.span_id, span2);

      const spans = cache.getByRootSpanId(rootSpanId);
      expect(spans).toHaveLength(2);
      expect(spans).toContainEqual(span1);
      expect(spans).toContainEqual(span2);
    });

    test("should return undefined for unknown rootSpanId", () => {
      const spans = cache.getByRootSpanId("nonexistent");
      expect(spans).toBeUndefined();
    });

    test("should merge span data on subsequent writes to same spanId", () => {
      const rootSpanId = "root-123";
      const spanId = "span-1";

      cache.queueWrite(rootSpanId, spanId, {
        span_id: spanId,
        input: { text: "hello" },
      });

      cache.queueWrite(rootSpanId, spanId, {
        span_id: spanId,
        output: { response: "world" },
      });

      const spans = cache.getByRootSpanId(rootSpanId);
      expect(spans).toHaveLength(1);
      expect(spans![0]).toEqual({
        span_id: spanId,
        input: { text: "hello" },
        output: { response: "world" },
      });
    });

    test("should merge metadata objects", () => {
      const rootSpanId = "root-123";
      const spanId = "span-1";

      cache.queueWrite(rootSpanId, spanId, {
        span_id: spanId,
        metadata: { key1: "value1" },
      });

      cache.queueWrite(rootSpanId, spanId, {
        span_id: spanId,
        metadata: { key2: "value2" },
      });

      const spans = cache.getByRootSpanId(rootSpanId);
      expect(spans![0].metadata).toEqual({
        key1: "value1",
        key2: "value2",
      });
    });
  });

  describe("has", () => {
    test("should return true when rootSpanId exists", () => {
      cache.queueWrite("root-123", "span-1", { span_id: "span-1" });
      expect(cache.has("root-123")).toBe(true);
    });

    test("should return false when rootSpanId does not exist", () => {
      expect(cache.has("nonexistent")).toBe(false);
    });
  });

  describe("clear", () => {
    test("should remove spans for a specific rootSpanId from index", () => {
      cache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      cache.queueWrite("root-2", "span-2", { span_id: "span-2" });

      cache.clear("root-1");

      expect(cache.has("root-1")).toBe(false);
      expect(cache.has("root-2")).toBe(true);
    });
  });

  describe("clearAll", () => {
    test("should remove all cached spans", () => {
      cache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      cache.queueWrite("root-2", "span-2", { span_id: "span-2" });

      cache.clearAll();

      expect(cache.size).toBe(0);
    });
  });

  describe("size", () => {
    test("should return the number of root spans tracked", () => {
      expect(cache.size).toBe(0);

      cache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(cache.size).toBe(1);

      cache.queueWrite("root-1", "span-2", { span_id: "span-2" }); // Same root
      expect(cache.size).toBe(1);

      cache.queueWrite("root-2", "span-3", { span_id: "span-3" }); // Different root
      expect(cache.size).toBe(2);
    });
  });

  describe("dispose", () => {
    test("should clean up and allow reuse", () => {
      cache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(cache.size).toBe(1);

      // Stop first to decrement refcount, then dispose
      cache.stop();
      cache.dispose();

      expect(cache.size).toBe(0);
      expect(cache.has("root-1")).toBe(false);

      // Should be able to write again after dispose (if we start again)
      cache.start();
      cache.queueWrite("root-2", "span-2", { span_id: "span-2" });
      expect(cache.size).toBe(1);
    });
  });

  describe("disable", () => {
    test("should prevent writes after disable() is called", () => {
      cache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(cache.size).toBe(1);

      cache.disable();

      // Writes after disable should be no-ops
      cache.queueWrite("root-2", "span-2", { span_id: "span-2" });
      expect(cache.size).toBe(1); // Still 1, not 2
    });

    test("should return undefined from getByRootSpanId after disable()", () => {
      cache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(cache.getByRootSpanId("root-1")).toBeDefined();

      cache.disable();

      // Reads after disable return undefined
      expect(cache.getByRootSpanId("root-1")).toBeUndefined();
    });

    test("disabled getter should reflect disabled state", () => {
      // Cache is enabled in beforeEach, so starts as not disabled
      expect(cache.disabled).toBe(false);
      cache.disable();
      expect(cache.disabled).toBe(true);

      // Creating a new cache without enable() should be disabled by default
      const newCache = new SpanCache();
      expect(newCache.disabled).toBe(true);
      newCache.dispose();
    });

    test("should be disabled from constructor option", () => {
      const disabledCache = new SpanCache({ disabled: true });
      expect(disabledCache.disabled).toBe(true);

      // Writes should be no-ops
      disabledCache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(disabledCache.size).toBe(0);
      expect(disabledCache.getByRootSpanId("root-1")).toBeUndefined();

      disabledCache.dispose();
    });
  });

  describe("start/stop lifecycle", () => {
    test("stop() allows start() to work again", () => {
      const freshCache = new SpanCache();

      // Initially disabled by default
      expect(freshCache.disabled).toBe(true);

      // Start for first "eval"
      freshCache.start();
      expect(freshCache.disabled).toBe(false);
      freshCache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(freshCache.size).toBe(1);

      // Stop after first "eval" (like calling stop() in finally block)
      freshCache.stop();
      freshCache.dispose();
      expect(freshCache.disabled).toBe(true);

      // Start for second "eval" - should work!
      freshCache.start();
      expect(freshCache.disabled).toBe(false);
      freshCache.queueWrite("root-2", "span-2", { span_id: "span-2" });
      expect(freshCache.size).toBe(1);

      freshCache.stop();
      freshCache.dispose();
    });

    test("disable() prevents start() from working", () => {
      const freshCache = new SpanCache();

      // Simulate OTEL/initFunction calling disable()
      freshCache.disable();
      expect(freshCache.disabled).toBe(true);

      // start() should be a no-op after disable()
      freshCache.start();
      expect(freshCache.disabled).toBe(true);

      // Writes should still be no-ops
      freshCache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(freshCache.size).toBe(0);

      freshCache.dispose();
    });

    test("disable() during active cache prevents future start()", () => {
      const freshCache = new SpanCache();

      // Start for "eval"
      freshCache.start();
      expect(freshCache.disabled).toBe(false);
      freshCache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      expect(freshCache.size).toBe(1);

      // Simulate OTEL being registered mid-eval
      freshCache.disable();
      expect(freshCache.disabled).toBe(true);

      // Stop after eval
      freshCache.dispose();
      freshCache.stop();

      // Future start() should be blocked because disable() was called
      freshCache.start();
      expect(freshCache.disabled).toBe(true);

      freshCache.dispose();
    });
  });

  describe("parallel eval support with reference counting", () => {
    test("should not dispose cache while evals are still running", () => {
      const sharedCache = new SpanCache();

      // Simulate two evals starting
      sharedCache.start(); // Eval 1
      expect(sharedCache.disabled).toBe(false);
      expect(sharedCache["_activeEvalCount"]).toBe(1);

      sharedCache.start(); // Eval 2
      expect(sharedCache.disabled).toBe(false);
      expect(sharedCache["_activeEvalCount"]).toBe(2);

      // Write data from both evals
      sharedCache.queueWrite("root-1", "span-1", { span_id: "span-1" });
      sharedCache.queueWrite("root-2", "span-2", { span_id: "span-2" });
      expect(sharedCache.size).toBe(2);

      // Eval 1 finishes first
      sharedCache.dispose(); // Should NOT dispose (refcount = 2)
      sharedCache.stop(); // Decrements to 1

      // Cache should still be enabled and data intact
      expect(sharedCache.disabled).toBe(false);
      expect(sharedCache["_activeEvalCount"]).toBe(1);
      expect(sharedCache.size).toBe(2);
      expect(sharedCache.getByRootSpanId("root-1")).toBeDefined();
      expect(sharedCache.getByRootSpanId("root-2")).toBeDefined();

      // Eval 2 finishes
      sharedCache.dispose(); // Should NOT dispose yet (refcount = 1)
      sharedCache.stop(); // Decrements to 0, disables cache

      // Now cache should be disabled but data still exists
      expect(sharedCache.disabled).toBe(true);
      expect(sharedCache["_activeEvalCount"]).toBe(0);

      // Final dispose should now work
      sharedCache.dispose(); // NOW it disposes (refcount = 0)
      expect(sharedCache.size).toBe(0);
    });

    test("should not increment refcount when explicitly disabled", () => {
      const disabledCache = new SpanCache({ disabled: true });

      disabledCache.start();
      expect(disabledCache["_activeEvalCount"]).toBe(0);
      expect(disabledCache.disabled).toBe(true);

      disabledCache.start();
      expect(disabledCache["_activeEvalCount"]).toBe(0);
      expect(disabledCache.disabled).toBe(true);

      disabledCache.dispose();
    });

    test("should handle refcount underflow gracefully", () => {
      const cache = new SpanCache();

      // Call stop without start
      cache.stop();
      expect(cache["_activeEvalCount"]).toBe(0);

      cache.stop();
      expect(cache["_activeEvalCount"]).toBe(0); // Should not go negative

      // Should still work normally after
      cache.start();
      expect(cache["_activeEvalCount"]).toBe(1);

      cache.dispose();
    });

    test("should simulate realistic parallel eval scenario", async () => {
      const sharedCache = new SpanCache();

      // Simulate Eval 1 starting
      sharedCache.start();
      sharedCache.queueWrite("eval1-root", "span-1", {
        span_id: "span-1",
        input: "eval1-input",
      });

      // Simulate Eval 2 starting (before Eval 1 finishes)
      sharedCache.start();
      sharedCache.queueWrite("eval2-root", "span-2", {
        span_id: "span-2",
        input: "eval2-input",
      });

      // Both evals should see their data
      expect(sharedCache.getByRootSpanId("eval1-root")).toBeDefined();
      expect(sharedCache.getByRootSpanId("eval2-root")).toBeDefined();

      // Eval 1 finishes
      sharedCache.dispose();
      sharedCache.stop();

      // Eval 2 should still have access
      expect(sharedCache.disabled).toBe(false);
      expect(sharedCache.getByRootSpanId("eval2-root")).toBeDefined();
      expect(sharedCache.getByRootSpanId("eval1-root")).toBeDefined();

      // Eval 2 finishes
      sharedCache.dispose();
      sharedCache.stop();

      // Now cache is disabled
      expect(sharedCache.disabled).toBe(true);

      // Final cleanup
      sharedCache.dispose();
    });
  });
});
