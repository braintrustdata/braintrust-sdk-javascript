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

import { wrapCloudflareAgent } from "./cloudflare-agent";

describe("wrapCloudflareAgent", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("wraps runAgentTool and preserves its result and receiver", async () => {
    class Agent {
      value = "receiver";

      async runAgentTool(cls: unknown, options: unknown) {
        return { cls, options, receiver: this.value, status: "completed" };
      }
    }
    class ChildAgent {}
    const options = { input: { query: "hello" } };

    expect(wrapCloudflareAgent(Agent)).toBe(Agent);
    const agent = new Agent();
    await expect(agent.runAgentTool(ChildAgent, options)).resolves.toEqual({
      cls: ChildAgent,
      options,
      receiver: "receiver",
      status: "completed",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect({
      self: invoke.mock.calls[0]?.[1],
      arguments: invoke.mock.calls[0]?.[2],
    }).toEqual({
      arguments: [ChildAgent, options],
      self: agent,
    });
  });

  it("patches each Agent class only once", async () => {
    class Agent {
      async runAgentTool() {
        return { status: "completed" };
      }
    }

    wrapCloudflareAgent(Agent);
    wrapCloudflareAgent(Agent);
    await new Agent().runAgentTool();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves rejections", async () => {
    const rejection = new Error("child rejected");
    class Agent {
      async runAgentTool() {
        throw rejection;
      }
    }

    wrapCloudflareAgent(Agent);

    await expect(new Agent().runAgentTool()).rejects.toBe(rejection);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not trace detached runs", async () => {
    class Agent {
      async runAgentTool(_cls: unknown, options: unknown) {
        return options;
      }
    }
    const inputGetter = vi.fn(() => "do not read");
    const options = Object.defineProperties(
      {},
      {
        detached: { value: { waitUntil: vi.fn() } },
        input: { get: inputGetter },
      },
    );

    wrapCloudflareAgent(Agent);
    await expect(new Agent().runAgentTool(class {}, options)).resolves.toBe(
      options,
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(inputGetter).not.toHaveBeenCalled();
  });

  it("returns unsupported values unchanged", () => {
    expect(wrapCloudflareAgent(undefined)).toBeUndefined();
    expect(wrapCloudflareAgent(class Unsupported {})).toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
