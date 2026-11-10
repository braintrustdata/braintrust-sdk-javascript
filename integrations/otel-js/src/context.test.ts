import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  context,
  trace,
  type ContextManager as OtelContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NoopSpan } from "../../../js/src/logger/core";
import { OtelContextManager } from "./context";

// Expose only the public contract. Private fields cannot be discovered through this wrapper.
let manager: AsyncLocalStorageContextManager;
beforeEach(() => {
  manager = new AsyncLocalStorageContextManager().enable();
  const publicManager: OtelContext = {
    active: () => manager.active(),
    with: (ctx, fn, thisArg, ...args) =>
      manager.with(ctx, fn, thisArg, ...args),
    bind: (ctx, target) => manager.bind(ctx, target),
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  };
  context.setGlobalContextManager(publicManager);
});
afterEach(() => {
  context.disable();
  manager.disable();
});

const span = Object.assign(new NoopSpan(), {
  rootSpanId: "1".repeat(32),
  spanId: "2".repeat(16),
});

test("application exceptions propagate without retrying the callback", () => {
  const bridge = new OtelContextManager();
  const error = new Error("application failure");
  let calls = 0;
  expect(() =>
    bridge.runInContext(span, () => {
      calls++;
      throw error;
    }),
  ).toThrow(error);
  expect(calls).toBe(1);
  expect(bridge.getCurrentSpan()).toBeUndefined();
});

test("public context APIs retain identity across async work and isolate concurrent requests", async () => {
  const bridge = new OtelContextManager();
  const other = Object.assign(new NoopSpan(), {
    rootSpanId: span.rootSpanId,
    spanId: "3".repeat(16),
  });
  await Promise.all(
    [span, other].map((current) =>
      bridge.runInContext(current, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(bridge.getCurrentSpan()).toBe(current);
        expect(trace.getSpanContext(context.active())?.spanId).toBe(
          current.spanId,
        );
        expect(bridge.getParentSpanIds()?.spanParents).toEqual([
          current.spanId,
        ]);
      }),
    ),
  );
  expect(bridge.getCurrentSpan()).toBeUndefined();
});

test("the instrumentation store uses the same public context as manual spans", async () => {
  const bridge = new OtelContextManager();
  const store = bridge.getCurrentSpanStore();
  await store.run(bridge.wrapSpanForStore(span), async () => {
    await Promise.resolve();
    expect(bridge.getCurrentSpan()).toBe(span);
    expect(store.getStore()).toBe(context.active());
  });
  expect(bridge.getCurrentSpan()).toBeUndefined();
});

test("the local bridge preserves an upstream sampling decision and trace state", () => {
  const bridge = new OtelContextManager();
  const unsampled = Object.assign(new NoopSpan(), {
    rootSpanId: span.rootSpanId,
    spanId: span.spanId,
    inject: () => ({
      traceparent: `00-${span.rootSpanId}-${span.spanId}-00`,
      tracestate: "vendor=value",
    }),
  });
  bridge.runInContext(unsampled, () => {
    const active = trace.getSpanContext(context.active())!;
    expect(active.traceFlags).toBe(0);
    expect(active.traceState?.serialize()).toBe("vendor=value");
    expect(active.isRemote).not.toBe(true);
  });
});
