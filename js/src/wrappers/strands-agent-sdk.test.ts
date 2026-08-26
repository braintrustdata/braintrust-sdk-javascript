import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(
    (
      target: Function,
      thisArg: unknown,
      args: unknown[],
      _additional?: unknown,
    ) => Reflect.apply(target, thisArg, args),
  ),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      invoke,
    })),
  },
}));

import { wrapStrandsAgentSDK } from "./strands-agent-sdk";

describe("wrapStrandsAgentSDK", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid modules unchanged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sdk = { AgentSession: class {} };

    expect(wrapStrandsAgentSDK(sdk)).toBe(sdk);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Strands Agent SDK. Not wrapping.",
    );

    warnSpy.mockRestore();
  });

  it("wraps Agent.stream and Agent.invoke through the same stream channel", async () => {
    class Agent {
      name = "assistant";

      async *stream(input: string) {
        yield { type: "agentResultEvent", result: { stopReason: "end_turn" } };
        return {
          lastMessage: { role: "assistant", content: [{ text: input }] },
        };
      }

      async invoke() {
        throw new Error("original invoke should not be called");
      }
    }

    const wrapped = wrapStrandsAgentSDK({ Agent }) as any;
    const agent = new wrapped.Agent();
    const chunks = [];
    for await (const chunk of agent.stream("hello")) {
      chunks.push(chunk);
    }
    const result = await agent.invoke("world");

    expect(chunks).toHaveLength(1);
    expect(result).toMatchObject({
      lastMessage: { role: "assistant", content: [{ text: "world" }] },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][2]).toEqual(["hello", undefined]);
    expect(invoke.mock.calls[0][3]).toMatchObject({
      agent: expect.objectContaining({ name: "assistant" }),
    });
    expect(invoke.mock.calls[1][2]).toEqual(["world", undefined]);
  });

  it("wraps Graph and Swarm stream/invoke", async () => {
    class Graph {
      async *stream(input: string) {
        yield { type: "multiAgentResultEvent" };
        return { status: "COMPLETED", content: [{ text: input }] };
      }

      async invoke() {
        throw new Error("original invoke should not be called");
      }
    }
    class Swarm {
      async *stream(input: string) {
        yield { type: "multiAgentResultEvent" };
        return { status: "COMPLETED", content: [{ text: input }] };
      }

      async invoke() {
        throw new Error("original invoke should not be called");
      }
    }

    const wrapped = wrapStrandsAgentSDK({ Graph, Swarm }) as any;

    await expect(new wrapped.Graph().invoke("graph")).resolves.toMatchObject({
      status: "COMPLETED",
    });
    await expect(new wrapped.Swarm().invoke("swarm")).resolves.toMatchObject({
      status: "COMPLETED",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][2]).toEqual(["graph", undefined]);
    expect(invoke.mock.calls[0][3]).toMatchObject({
      orchestrator: expect.anything(),
    });
    expect(invoke.mock.calls[1][2]).toEqual(["swarm", undefined]);
    expect(invoke.mock.calls[1][3]).toMatchObject({
      orchestrator: expect.anything(),
    });
  });

  it("does not double-wrap already wrapped classes", async () => {
    class Agent {
      async *stream() {
        return { stopReason: "end_turn" };
      }

      async invoke() {
        throw new Error("original invoke should not be called");
      }
    }

    const wrapped = wrapStrandsAgentSDK(
      wrapStrandsAgentSDK({ Agent }) as any,
    ) as any;

    await new wrapped.Agent().invoke("hello");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves private-field-safe method binding", async () => {
    class Agent {
      #value = "secret";

      async *stream() {
        return { value: this.#value };
      }

      async invoke() {
        throw new Error("original invoke should not be called");
      }

      read() {
        return this.#value;
      }
    }

    const wrapped = wrapStrandsAgentSDK({ Agent }) as any;
    const agent = new wrapped.Agent();

    expect(agent.read()).toBe("secret");
    await expect(agent.invoke("hello")).resolves.toEqual({ value: "secret" });
  });

  it("preserves non-instrumented function and class exports unchanged", () => {
    class Agent {
      async *stream() {
        return { stopReason: "end_turn" };
      }
    }
    class Message {
      static fromMessageData(data: unknown) {
        return { data };
      }
    }
    class InterruptResponseContent {
      static fromJSON(json: unknown) {
        return { json };
      }
    }
    function helper() {
      return "ok";
    }

    const wrapped = wrapStrandsAgentSDK({
      Agent,
      helper,
      InterruptResponseContent,
      Message,
    });

    expect(wrapped.Message).toBe(Message);
    expect(wrapped.Message.fromMessageData({ role: "user" })).toEqual({
      data: { role: "user" },
    });
    expect(wrapped.InterruptResponseContent).toBe(InterruptResponseContent);
    expect(
      wrapped.InterruptResponseContent.fromJSON({ type: "interrupt" }),
    ).toEqual({
      json: { type: "interrupt" },
    });
    expect(wrapped.helper).toBe(helper);
  });
});
