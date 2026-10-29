import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
const { spans } = vi.hoisted(() => ({ spans: [] as any[] }));
vi.mock("../../isomorph", () => ({
  default: { newAsyncLocalStorage: <T>() => new AsyncLocalStorage<T>() },
}));
vi.mock("../../logger", () => ({
  startSpan: (args: any) => {
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
import { CursorSDKPlugin } from "./cursor-sdk-plugin";
import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";

describe("Cursor automatic and manual wrapping", () => {
  const plugin = new CursorSDKPlugin();
  afterEach(() => {
    plugin.disable();
    spans.length = 0;
  });

  it.each(["manual", "automatic", "combined"] as const)(
    "captures one prompt task and its tools with %s instrumentation",
    async (mode) => {
      plugin.enable();
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
      const stream = (async function* () {
        for (const event of events) yield event;
      })();
      const run = {
        status: "finished",
        stream: () => stream,
        async wait() {
          return { status: "finished", result: "ok" };
        },
      };
      const agent = { send: vi.fn(async () => run) };
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
          const instance = await this.create({});
          const run = await instance.send();
          for await (const _ of run.stream()) {
            /* consume */
          }
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
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spans.map((span) => span.name)).toEqual(["Cursor Agent", "shell"]);
      for (const span of spans) expect(span.end).toHaveBeenCalledOnce();
    },
  );

  it("keeps installed wrappers usable after disabling instrumentation", async () => {
    plugin.enable();
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
    plugin.disable();
    expect(() => agent.send()).toThrow(error);
    expect(() => wrapped.Agent.prompt()).toThrow(error);
    expect(spans).toHaveLength(0);
  });
});
