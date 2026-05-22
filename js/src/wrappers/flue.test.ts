import { afterEach, describe, expect, it, vi } from "vitest";

const {
  publishAsyncEnd,
  publishAsyncStart,
  publishEnd,
  publishStart,
  tracePromise,
  traceSync,
} = vi.hoisted(() => ({
  publishAsyncEnd: vi.fn(),
  publishAsyncStart: vi.fn(),
  publishEnd: vi.fn(),
  publishStart: vi.fn(),
  tracePromise: vi.fn(
    async (fn: () => Promise<unknown>, context: Record<string, unknown>) => {
      publishStart(context);
      try {
        const result = fn();
        publishEnd(context);
        const resolved = await result;
        context.result = resolved;
        publishAsyncStart(context);
        publishAsyncEnd(context);
        return resolved;
      } catch (error) {
        throw error;
      }
    },
  ),
  traceSync: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      asyncEnd: {
        publish: publishAsyncEnd,
      },
      asyncStart: {
        publish: publishAsyncStart,
      },
      end: {
        publish: publishEnd,
      },
      error: {
        publish: vi.fn(),
      },
      start: {
        publish: publishStart,
        runStores: vi.fn((context, fn) => {
          publishStart(context);
          return fn();
        }),
      },
      subscribe: vi.fn(),
      tracePromise,
      traceSync,
      unsubscribe: vi.fn(),
    })),
  },
}));

import { wrapFlueContext, wrapFlueSession } from "./flue";

describe("wrapFlueSession", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("patches prompt, skill, task, and compact", async () => {
    const session = makeSession();

    wrapFlueSession(session);

    await session.prompt("hello", { model: "pi/test" });
    await session.skill("review", { args: { id: 1 } });
    await session.task("delegate this");
    await session.compact();

    expect(publishStart).toHaveBeenCalledTimes(4);
    expect(publishEnd).toHaveBeenCalledTimes(4);
    expect(publishAsyncStart).toHaveBeenCalledTimes(4);
    expect(publishAsyncEnd).toHaveBeenCalledTimes(4);
    expect(session.originals.prompt).toHaveBeenCalledWith("hello", {
      model: "pi/test",
    });
    expect(session.originals.skill).toHaveBeenCalledWith("review", {
      args: { id: 1 },
    });
    expect(session.originals.task).toHaveBeenCalledWith(
      "delegate this",
      undefined,
    );
    expect(session.originals.compact).toHaveBeenCalledTimes(1);
  });

  it("preserves CallHandle signal, abort, and then behavior", async () => {
    const controller = new AbortController();
    const abort = vi.fn();
    const promise = Promise.resolve({ text: "ok" });
    const handle = {
      abort,
      signal: controller.signal,
      then: promise.then.bind(promise),
    };
    const session = {
      compact: vi.fn(async () => undefined),
      name: "main",
      prompt: vi.fn(() => handle),
      skill: vi.fn(() => handle),
      task: vi.fn(() => handle),
    };

    wrapFlueSession(session);
    const returned = session.prompt("hello");

    expect(returned).not.toBe(handle);
    expect(returned.signal).toBe(controller.signal);
    returned.abort("stop");
    await expect(returned).resolves.toEqual({ text: "ok" });
    expect(abort).toHaveBeenCalledWith("stop");
  });

  it("is idempotent", async () => {
    const session = makeSession();

    wrapFlueSession(session);
    wrapFlueSession(session);
    await session.prompt("hello");

    expect(publishStart).toHaveBeenCalledTimes(1);
    expect(session.originals.prompt).toHaveBeenCalledTimes(1);
  });
});

describe("wrapFlueContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to context events and wraps harness sessions returned by init", async () => {
    let subscriber: ((event: unknown) => void) | undefined;
    const session = makeSession();
    const harness = {
      name: "default",
      session: vi.fn(async () => session),
      sessions: {
        create: vi.fn(async () => session),
        get: vi.fn(async () => session),
      },
    };
    const ctx = {
      init: vi.fn(async () => harness),
      subscribeEvent: vi.fn((callback) => {
        subscriber = callback;
        return vi.fn();
      }),
    };

    wrapFlueContext(ctx);
    const returnedHarness = await ctx.init({ model: "pi/test" });
    const returnedSession = await returnedHarness.session("main");

    await returnedSession.prompt("hello");
    subscriber?.({ operationId: "op_1", type: "operation_start" });

    expect(ctx.subscribeEvent).toHaveBeenCalledTimes(1);
    expect(publishStart).toHaveBeenCalledTimes(1);
    expect(traceSync).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        arguments: [{ operationId: "op_1", type: "operation_start" }],
        context: ctx,
      }),
    );
  });

  it("returns invalid contexts unchanged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = { session: vi.fn() };

    expect(wrapFlueContext(value)).toBe(value);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Flue context. Not wrapping.",
    );

    warnSpy.mockRestore();
  });
});

function makeHandle(result: unknown = { text: "ok" }) {
  const promise = Promise.resolve(result);
  return {
    abort: vi.fn(),
    signal: new AbortController().signal,
    then: promise.then.bind(promise),
  };
}

function makeSession() {
  const originals = {
    compact: vi.fn(async () => undefined),
    prompt: vi.fn(() => makeHandle({ text: "prompt ok" })),
    skill: vi.fn(() => makeHandle({ text: "skill ok" })),
    task: vi.fn(() => makeHandle({ text: "task ok" })),
  };

  return {
    compact: originals.compact,
    name: "main",
    originals,
    prompt: originals.prompt,
    skill: originals.skill,
    task: originals.task,
  };
}
