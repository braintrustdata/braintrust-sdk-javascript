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

import { wrapCloudflareAIChat } from "./cloudflare-ai-chat";

describe("wrapCloudflareAIChat", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns unsupported modules unchanged", () => {
    const module = { useAgentChat: () => undefined };
    expect(wrapCloudflareAIChat(module)).toBe(module);
  });

  it("wraps complete chat turns without changing subclass behavior", async () => {
    class AIChatAgent {
      static kind = "ai-chat";
      #secret = "private-value";
      messages = [
        { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ];

      async _runExclusiveChatTurn(
        requestId: string,
        callback: () => Promise<unknown>,
      ) {
        return { requestId, value: await callback() };
      }

      onChatResponse() {}

      readSecret() {
        return this.#secret;
      }
    }

    const module = wrapCloudflareAIChat({ AIChatAgent, untouched: "value" });
    class ChatAgent extends module.AIChatAgent {
      onChatResponse = () => "field-hook";
    }

    const agent = new ChatAgent();
    const result = await agent._runExclusiveChatTurn("request-1", async () =>
      agent.readSecret(),
    );

    expect(result).toEqual({ requestId: "request-1", value: "private-value" });
    expect(agent).toBeInstanceOf(AIChatAgent);
    expect(agent.onChatResponse()).toBe("field-hook");
    expect(module.AIChatAgent.kind).toBe("ai-chat");
    expect(module.untouched).toBe("value");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect({
      self: invoke.mock.calls[0]?.[1],
      arguments: invoke.mock.calls[0]?.[2],
    }).toMatchObject({
      arguments: ["request-1", expect.any(Function)],
      self: agent,
    });
  });

  it("preserves errors and does not double-wrap the class", async () => {
    const failure = new Error("turn failed");
    class AIChatAgent {
      async _runExclusiveChatTurn(
        _requestId: string,
        _callback: () => Promise<unknown>,
      ) {
        throw failure;
      }
      onChatResponse() {}
    }

    const wrappedOnce = wrapCloudflareAIChat({ AIChatAgent });
    const WrappedAIChatAgent = wrappedOnce.AIChatAgent;
    const wrappedTwice = wrapCloudflareAIChat(wrappedOnce);
    const agent = new wrappedTwice.AIChatAgent();

    expect(wrappedTwice.AIChatAgent).toBe(WrappedAIChatAgent);
    await expect(
      agent._runExclusiveChatTurn("request-1", async () => {}),
    ).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
