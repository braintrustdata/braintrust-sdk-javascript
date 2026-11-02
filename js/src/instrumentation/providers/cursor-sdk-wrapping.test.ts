import { resetInstrumentationForTest } from "../test-utils/reset";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const { spans } = vi.hoisted(() => ({ spans: [] as any[] }));
vi.mock("#braintrust-platform", () => ({
  default: {
    newAsyncLocalStorage: <T>() => new AsyncLocalStorage<T>(),
    getEnv: () => undefined,
  },
}));
vi.mock("../../logger/core", () => ({
  _internalStartSpan: (args: any) => {
    const span = {
      ...args,
      end: vi.fn(),
      log: vi.fn(),
      export: async () => args.name,
    };
    spans.push(span);
    return span;
  },
  withCurrent: (_span: unknown, call: () => unknown) => call(),
}));
import { wrapCursorSDK } from "../../wrappers/cursor-sdk";
import { registerInstrumentation } from "../registrations/cursorSDK";
import {
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  newGlobalInvocationHook,
} from "../../global-instrumentation-hooks";

describe("Cursor automatic and manual wrapping", () => {
  afterEach(() => {
    resetInstrumentationForTest();
    spans.length = 0;
  });

  it.each(["manual", "automatic", "combined"] as const)(
    "captures one task per prompt/send with %s instrumentation",
    async (mode) => {
      registerInstrumentation();
      const events = [
        {
          type: "tool_call",
          call_id: "call",
          name: "shell",
          status: "completed",
          args: { command: "pwd" },
          result: "ok",
        },
      ];
      const agent = {
        send: vi.fn(async () => ({
          status: "finished",
          stream: async function* () {
            for (const event of events) yield event;
          },
          async wait() {
            return { status: "finished", result: "ok" };
          },
        })),
      };
      const createPromise = Promise.resolve(agent);
      class Agent {
        static #value = "ok";
        static create(_options: unknown) {
          return createPromise;
        }
        static resume() {
          return createPromise;
        }
        static async prompt(_message: string) {
          // Cursor's distributed prompt calls its lexical Agent class, not this.
          const instance = await Agent.create({});
          const run = await instance.send();
          await run.wait();
          return { result: this.#value };
        }
      }
      if (mode !== "manual") {
        for (const operation of ["create", "resume", "prompt"] as const) {
          const original = Agent[operation];
          const hook = newGlobalInvocationHook(
            `orchestrion:@cursor/sdk:Agent.${operation}`,
          );
          Object.defineProperty(Agent, operation, {
            configurable: true,
            writable: true,
            value(...args: unknown[]) {
              return hook.invoke(
                original as (...args: unknown[]) => unknown,
                Agent,
                args,
                { moduleVersion: "1.0.12" },
              );
            },
          });
        }
      }
      const wrapped =
        mode === "automatic" ? { Agent } : wrapCursorSDK({ Agent });
      expect(await wrapped.Agent.prompt("hi")).toEqual({ result: "ok" });
      const instance = await wrapped.Agent.create({});
      const run = await instance.send();
      for await (const _ of run.stream()) {
        /* consume */
      }
      await run.wait();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spans.map((span) => span.name)).toEqual([
        "Cursor Agent",
        "Cursor Agent",
        "shell",
      ]);
      for (const span of spans) expect(span.end).toHaveBeenCalledOnce();
    },
  );

  it("keeps installed wrappers usable without tracing interceptors", async () => {
    registerInstrumentation();
    const error = new Error("provider failed");
    class Agent {
      static create() {
        return Promise.resolve({
          send() {
            throw error;
          },
        });
      }
      static resume() {
        return this.create();
      }
      static prompt() {
        throw error;
      }
    }
    const wrapped = wrapCursorSDK({ Agent });
    const agent = await wrapped.Agent.create();
    (globalThis as any)[GLOBAL_INSTRUMENTATION_HOOKS_KEY]?.clear();
    expect(() => agent.send()).toThrow(error);
    expect(() => wrapped.Agent.prompt()).toThrow(error);
    expect(spans).toHaveLength(0);
  });
});
