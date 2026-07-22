import { beforeAll, describe, expect, test, vi } from "vitest";
import type { Span } from "../../logger";
import { _exportsForTestingOnly } from "../../logger";
import { configureNode } from "../../node/config";
import {
  captureHarnessCreateSessionParent,
  extendHarnessTurn,
  registerHarnessTurnSpan,
} from "../../wrappers/ai-sdk/harness-agent-context";

try {
  configureNode();
} catch {}

const contextKey = "__braintrust_trace_context";

function exportOnlySpan(exported: () => Promise<string>): Span {
  return {
    export: exported,
    getParentInfo: () => undefined,
    id: "row-id",
    rootSpanId: "root-span-id",
    spanId: "span-id",
  } as unknown as Span;
}

describe("HarnessAgent continuation context", () => {
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  test("preserves lifecycle promises, result identity, prototypes, and descriptors", async () => {
    const prototype = { kind: "continuation" };
    const suspended = Object.create(prototype) as Record<string, unknown>;
    Object.defineProperty(suspended, "hidden", {
      configurable: false,
      enumerable: false,
      value: 42,
      writable: false,
    });
    Object.defineProperty(suspended, "throwing", {
      enumerable: true,
      get() {
        throw new Error("must not enumerate continuation state");
      },
    });
    const detachedContinuation: Record<string, unknown> = { cursor: 2 };
    const stoppedContinuation: Record<string, unknown> = { cursor: 3 };
    const detached = { continueFrom: detachedContinuation };
    const stopped = { continueFrom: stoppedContinuation };

    class Session {
      readonly sessionId = "session-1";
      readonly suspendPromise = Promise.resolve(suspended);

      suspendTurn() {
        return this.suspendPromise;
      }

      detach() {
        return Promise.resolve(detached);
      }

      stop() {
        return Promise.resolve(stopped);
      }
    }

    const session = new Session();
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Session.prototype,
      "suspendTurn",
    );
    const span = exportOnlySpan(async () => "exported-parent");
    registerHarnessTurnSpan({ continuation: false, session, span });

    const suspendPromise = session.suspendTurn();
    expect(suspendPromise).toBe(session.suspendPromise);
    await expect(suspendPromise).resolves.toBe(suspended);
    expect(Object.hasOwn(session, "suspendTurn")).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(Session.prototype, "suspendTurn"),
    ).toMatchObject({
      configurable: originalDescriptor?.configurable,
      enumerable: originalDescriptor?.enumerable,
      writable: originalDescriptor?.writable,
    });
    expect(Object.getPrototypeOf(suspended)).toBe(prototype);
    expect(Object.getOwnPropertyDescriptor(suspended, "hidden")).toEqual({
      configurable: false,
      enumerable: false,
      value: 42,
      writable: false,
    });

    // The throwing getter prevents state authentication, but context injection
    // remains contained and the exact lifecycle result is still returned.
    expect(suspended).not.toHaveProperty(contextKey);

    await expect(session.detach()).resolves.toBe(detached);
    expect(detachedContinuation[contextKey]).toMatchObject({
      parent: "exported-parent",
      signature: expect.any(String),
      version: 2,
    });

    await expect(session.stop()).resolves.toBe(stopped);
    expect(stoppedContinuation[contextKey]).toMatchObject({
      parent: "exported-parent",
      signature: expect.any(String),
      version: 2,
    });
  });

  test("does not wait for export or lifecycle-state access", async () => {
    const suspended = { cursor: 1 };
    const resumeState = Object.defineProperty({}, "continueFrom", {
      get() {
        throw new Error("unreadable continuation");
      },
    });
    const suspendPromise = Promise.resolve(suspended);
    const session = {
      detach: () => Promise.resolve(resumeState),
      sessionId: "session-2",
      suspendTurn: () => suspendPromise,
    };
    const span = exportOnlySpan(() => new Promise(() => {}));

    registerHarnessTurnSpan({ continuation: false, session, span });

    expect(session.suspendTurn()).toBe(suspendPromise);
    await expect(suspendPromise).resolves.toBe(suspended);
    expect(suspended).not.toHaveProperty(contextKey);
    await expect(session.detach()).resolves.toBe(resumeState);
  });

  test("authenticates and binds serialized parents to lifecycle state and session", async () => {
    const parent = exportOnlySpan(async () => "signed-parent");
    const session = {
      sessionId: "bound-session",
      suspendTurn: async () => ({ cursor: 1 }),
    };
    registerHarnessTurnSpan({ continuation: false, session, span: parent });
    const continuation = await session.suspendTurn();
    const serialized = JSON.parse(JSON.stringify(continuation));

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: serialized,
        sessionId: "bound-session",
      }),
    ).toBe("signed-parent");
    expect(
      captureHarnessCreateSessionParent({
        continueFrom: serialized,
        sessionId: "bound-session",
      }),
    ).toBe("signed-parent");

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: { ...serialized, cursor: 2 },
        sessionId: "bound-session",
      }),
    ).toBeUndefined();
    expect(
      captureHarnessCreateSessionParent({
        continueFrom: serialized,
        sessionId: "different-session",
      }),
    ).toBeUndefined();

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: {
          [contextKey]: {
            parent: "caller-controlled-parent",
            signature: "forged",
            version: 2,
          },
        },
        sessionId: "bound-session",
      }),
    ).toBeUndefined();

    expect(
      captureHarnessCreateSessionParent({
        get continueFrom() {
          throw new Error("untrusted getter");
        },
      }),
    ).toBeUndefined();
  });

  test("updates trusted local parents with final output, usage, and end", () => {
    const log = vi.fn();
    const parent = { log } as unknown as Span;

    extendHarnessTurn(parent, {
      metrics: { completion_tokens: 2, prompt_tokens: 3, tokens: 5 },
      output: "finished",
    });

    expect(log).toHaveBeenNthCalledWith(1, { output: null });
    expect(log).toHaveBeenNthCalledWith(2, {
      metrics: {
        completion_tokens: 2,
        end: expect.any(Number),
        prompt_tokens: 3,
        tokens: 5,
      },
      output: "finished",
    });
  });
});
