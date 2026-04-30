import { afterEach, describe, expect, it, vi } from "vitest";

const { tracePromise } = vi.hoisted(() => ({
  tracePromise: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      subscribe: vi.fn(),
      tracePromise,
      unsubscribe: vi.fn(),
    })),
  },
}));

import { wrapCursorSDK } from "./cursor-sdk";

describe("wrapCursorSDK", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid modules unchanged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sdk = { Cursor: {} };

    expect(wrapCursorSDK(sdk)).toBe(sdk);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Cursor SDK. Not wrapping.",
    );

    warnSpy.mockRestore();
  });

  it("wraps Agent.create and returned agent.send", async () => {
    const run = makeRun();
    const agent = {
      agentId: "agent-1",
      send: vi.fn(async () => run),
    };
    const sdk = {
      Agent: class {
        static async create() {
          return agent;
        }
      },
    };

    const wrapped = wrapCursorSDK(sdk);
    const created = await wrapped.Agent.create({ local: { cwd: "/tmp/repo" } });
    const result = await created.send("hello", {
      onDelta: vi.fn(),
      onStep: vi.fn(),
    });

    expect(result).toBe(run);
    expect(agent.send).toHaveBeenCalledWith("hello", expect.any(Object));
    expect(tracePromise).toHaveBeenCalledTimes(2);
  });

  it("wraps Agent.resume and preserves private-field-safe method binding", async () => {
    class PrivateAgent {
      #run = makeRun();
      agentId = "agent-2";

      async send() {
        return this.#run;
      }

      async [Symbol.asyncDispose]() {
        return undefined;
      }
    }

    const sdk = {
      Agent: class {
        static async resume() {
          return new PrivateAgent();
        }
      },
    };

    const wrapped = wrapCursorSDK(sdk);
    const agent = await wrapped.Agent.resume("agent-2");

    await expect(agent.send("hello")).resolves.toMatchObject({ id: "run-1" });
    await expect(agent[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it("wraps Agent.prompt", async () => {
    const sdk = {
      Agent: class {
        static async prompt(message: string) {
          return { id: "run-1", result: message, status: "finished" };
        }
      },
    };

    const wrapped = wrapCursorSDK(sdk);
    await expect(wrapped.Agent.prompt("hello")).resolves.toMatchObject({
      result: "hello",
    });
    expect(tracePromise).toHaveBeenCalledTimes(1);
  });

  it("handles module namespace-like objects", async () => {
    const Agent = class {
      static async prompt() {
        return { status: "finished" };
      }
    };
    const sdk = Object.defineProperty({}, "Agent", {
      configurable: false,
      enumerable: true,
      value: Agent,
      writable: false,
    });

    const wrapped = wrapCursorSDK(sdk as { Agent: typeof Agent });

    await expect(wrapped.Agent.prompt("hello")).resolves.toMatchObject({
      status: "finished",
    });
  });
});

function makeRun() {
  return {
    agentId: "agent-1",
    async conversation() {
      return [];
    },
    id: "run-1",
    stream: async function* () {
      yield {
        type: "assistant",
        message: { content: [{ text: "hello", type: "text" }] },
      };
    },
    async wait() {
      return { id: "run-1", result: "hello", status: "finished" };
    },
  };
}
