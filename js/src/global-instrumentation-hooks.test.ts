import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { tracingChannel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  getGlobalTracingChannel,
  newGlobalTracingChannel,
} from "./global-instrumentation-hooks";

function uniqueChannelName(label: string): string {
  return `test:${label}:${randomUUID()}`;
}

describe("global instrumentation hooks", () => {
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
    expect(getGlobalTracingChannel(name)).toBe(channel);
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
