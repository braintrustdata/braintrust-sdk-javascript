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
    expect(tracePromise).toHaveBeenCalledTimes(1);
    expect(tracePromise.mock.calls[0][1]).toMatchObject({
      arguments: ["hello", undefined],
      self: session,
      session,
    });
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
    expect(tracePromise).toHaveBeenCalledTimes(1);
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
    expect(tracePromise).toHaveBeenCalledTimes(1);
  });
});
