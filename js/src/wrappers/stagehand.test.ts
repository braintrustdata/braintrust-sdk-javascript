import { afterEach, describe, expect, it, vi } from "vitest";

const { tracePromise, traceSync } = vi.hoisted(() => ({
  tracePromise: vi.fn((fn: () => PromiseLike<unknown>) => fn()),
  traceSync: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      subscribe: vi.fn(),
      tracePromise,
      traceSync,
      unsubscribe: vi.fn(),
    })),
  },
}));

import { wrapStagehand } from "./stagehand";

describe("wrapStagehand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("preserves class aliases, instanceof, static properties, and private fields", async () => {
    class Stagehand {
      static version = "3.7.1";
      #model = "private-model";

      async act(value: unknown) {
        return { model: this.#model, value };
      }
      async extract(value: unknown) {
        return value;
      }
      async observe(value: unknown) {
        return value;
      }
      agent() {
        return { execute: async (value: unknown) => value };
      }
    }
    const wrapped = wrapStagehand({ Stagehand, V3: Stagehand });

    expect(wrapped.Stagehand).toBe(wrapped.V3);
    expect(wrapped.Stagehand.version).toBe("3.7.1");
    const instance = new wrapped.Stagehand();
    expect(instance).toBeInstanceOf(Stagehand);
    await expect(instance.act("secret instruction")).resolves.toEqual({
      model: "private-model",
      value: "secret instruction",
    });
    expect(tracePromise).toHaveBeenCalledTimes(1);
  });

  it("wraps public methods and agent execute once without changing results", async () => {
    const originalExecute = vi.fn(async (value: unknown) => value);
    const agent = { execute: originalExecute };
    class Stagehand {
      act = vi.fn(async () => "act");
      extract = vi.fn(async () => "extract");
      observe = vi.fn(async () => "observe");
      agent = vi.fn(() => agent);
    }
    const wrapped = wrapStagehand({ Stagehand });
    const instance = new wrapped.Stagehand();

    await expect(instance.act()).resolves.toBe("act");
    await expect(instance.extract()).resolves.toBe("extract");
    await expect(instance.observe()).resolves.toBe("observe");
    const firstAgent = instance.agent();
    const wrappedExecute = firstAgent.execute;
    expect(instance.agent()).toBe(firstAgent);
    expect(firstAgent.execute).toBe(wrappedExecute);
    await expect(firstAgent.execute("execute")).resolves.toBe("execute");

    expect(traceSync).toHaveBeenCalledTimes(2);
    expect(tracePromise).toHaveBeenCalledTimes(4);
    expect(originalExecute).toHaveBeenCalledWith("execute");
  });

  it("preserves thrown and rejected errors", async () => {
    const syncError = new Error("factory failed");
    const asyncError = new Error("act failed");
    class Stagehand {
      async act() {
        throw asyncError;
      }
      async extract() {}
      async observe() {}
      agent(): never {
        throw syncError;
      }
    }
    const instance = new (wrapStagehand({ Stagehand }).Stagehand)();

    await expect(instance.act()).rejects.toBe(asyncError);
    expect(() => instance.agent()).toThrow(syncError);
  });

  it("handles module namespace-like objects", () => {
    class Stagehand {}
    const sdk = Object.defineProperty({}, "Stagehand", {
      configurable: false,
      enumerable: true,
      value: Stagehand,
      writable: false,
    });

    const wrapped = wrapStagehand(sdk as { Stagehand: typeof Stagehand });
    expect(new wrapped.Stagehand()).toBeInstanceOf(Stagehand);
  });
});
