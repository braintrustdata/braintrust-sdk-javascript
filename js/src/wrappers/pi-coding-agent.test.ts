import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(
    (target: (...args: any[]) => unknown, thisArg: unknown, args: unknown[]) =>
      Reflect.apply(target, thisArg, args),
  ),
}));

vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(() => ({
      hasInterceptors: true,
      hasSubscribers: false,
      invoke,
    })),
  },
}));

import { wrapPiCodingAgentSDK } from "./pi-coding-agent";

describe("wrapPiCodingAgentSDK", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid modules unchanged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sdk = { Session: class {} };

    expect(wrapPiCodingAgentSDK(sdk)).toBe(sdk);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Pi Coding Agent SDK. Not wrapping.",
    );

    warnSpy.mockRestore();
  });

  it("wraps AgentSession.prompt", async () => {
    class AgentSession {
      async prompt(text: string) {
        return text;
      }
    }

    const sdk = { AgentSession };
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

  it("patches AgentSession.prompt only once", async () => {
    class AgentSession {
      async prompt(text: string) {
        return text;
      }
    }

    const sdk = { AgentSession };
    wrapPiCodingAgentSDK(sdk);
    wrapPiCodingAgentSDK(sdk);

    await new sdk.AgentSession().prompt("hello");
    expect(invoke).toHaveBeenCalledTimes(1);
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
