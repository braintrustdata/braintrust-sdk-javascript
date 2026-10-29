import { debugLogger } from "../debug-logger";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(
    (
      target: (...args: any[]) => any,
      receiver: unknown,
      args: unknown[],
      _additional?: unknown,
    ) => Reflect.apply(target, receiver, args),
  ),
}));
vi.mock("../global-instrumentation-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../global-instrumentation-hooks")>()),
  newGlobalInvocationHook: vi.fn(() => ({ invoke })),
}));

import { wrapCursorSDK } from "./cursor-sdk";

describe("wrapCursorSDK", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid modules unchanged", () => {
    const warnSpy = vi
      .spyOn(debugLogger.notice, "warn")
      .mockImplementation(() => true);
    const sdk = { Cursor: {} };

    expect(wrapCursorSDK(sdk)).toBe(sdk);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Cursor SDK. Not wrapping.",
    );

    warnSpy.mockRestore();
  });

  it("wraps create/resume agents once and preserves private-field methods", async () => {
    const run = { id: "run-1" };
    class PrivateAgent {
      #run = run;
      async send() {
        return this.#run;
      }
      async [Symbol.asyncDispose]() {
        return this.#run.id;
      }
    }
    const agent = new PrivateAgent();
    const originalSend = vi.spyOn(agent, "send");
    const sdk = {
      Agent: class {
        static async create() {
          return agent;
        }
        static async resume() {
          return agent;
        }
      },
    };
    const wrapped = wrapCursorSDK(sdk as any) as any;
    const created = await wrapped.Agent.create({});
    const patchedSend = created.send;
    const resumed = await wrapped.Agent.resume("agent-1");
    expect(resumed).toBe(created);
    expect(resumed.send).toBe(patchedSend);
    await expect(resumed.send("hello")).resolves.toBe(run);
    expect(originalSend).toHaveBeenCalledExactlyOnceWith("hello");
    await expect(resumed[Symbol.asyncDispose]()).resolves.toBe("run-1");
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("handles module namespaces and preserves static promises, arguments, and private getters", async () => {
    const agent = { send: vi.fn() };
    const promise = Object.assign(Promise.resolve(agent), {
      helper: () => "ok",
    });
    class Agent {
      static #value = "ok";
      static get value() {
        return this.#value;
      }
      static create(...args: unknown[]) {
        expect(args).toEqual([{}]);
        return promise;
      }
      static resume(...args: unknown[]) {
        expect(args).toEqual(["agent-1"]);
        return promise;
      }
      static prompt(...args: unknown[]) {
        expect(args).toEqual(["hi"]);
        return promise;
      }
    }
    const sdk = Object.defineProperty({ Agent }, "Agent", {
      configurable: false,
      writable: false,
    });
    const wrapped = wrapCursorSDK(sdk);
    expect(wrapped.Agent.value).toBe("ok");
    expect(wrapped.Agent).toBe(wrapped.Agent);
    expect(wrapped.Agent.create({})).toBe(promise);
    expect(wrapped.Agent.resume("agent-1")).toBe(promise);
    expect(wrapped.Agent.prompt("hi")).toBe(promise);
    await promise;
  });
});
