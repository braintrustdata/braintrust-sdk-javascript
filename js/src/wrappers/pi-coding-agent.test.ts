import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
  newGlobalInvocationHook: vi.fn(() => ({
    invoke,
    intercept: vi.fn(() => () => {}),
  })),
}));

import { wrapPiCodingAgentSDK } from "./pi-coding-agent";

describe("wrapPiCodingAgentSDK", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("wraps AgentSession.prompt once while preserving receiver, arguments, and result", async () => {
    class AgentSession {
      async prompt(text: string) {
        return text;
      }
    }

    const sdk = { AgentSession };
    wrapPiCodingAgentSDK(sdk);
    wrapPiCodingAgentSDK(sdk);
    const session = new sdk.AgentSession();

    await expect(session.prompt("hello")).resolves.toBe("hello");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0].slice(1)).toEqual([
      session,
      ["hello", undefined],
      {
        session,
      },
    ]);
  });

  it("preserves prompt rejections", async () => {
    class AgentSession {
      async prompt() {
        throw new Error("prompt failed");
      }
    }

    const sdk = { AgentSession };
    wrapPiCodingAgentSDK(sdk);

    await expect(new sdk.AgentSession().prompt()).rejects.toThrow(
      "prompt failed",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
