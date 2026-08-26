import { describe, expect, test, vi } from "vitest";
import { _internalGetGlobalState, type Span } from "../../logger";
import { configureNode } from "../../node/config";
import { SpanObjectTypeV3 } from "../../util";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";
import {
  captureHarnessCreateSessionParent,
  endHarnessTurn,
  registerHarnessTurnSpan,
  updateHarnessTurn,
} from "../../wrappers/ai-sdk/harness-agent-context";

try {
  configureNode();
} catch {}
_internalGetGlobalState()._internalSetTraceContextSigningSecret(
  "harness-context-test-secret",
);

const contextKey = "__braintrust_trace_context";

function serializableSpan(exported = vi.fn()): Span {
  return {
    export: exported,
    getParentInfo: () =>
      ({
        computeObjectMetadataArgs: undefined,
        objectId: {
          getSync: () => ({ value: "project-id" }),
        },
        objectType: SpanObjectTypeV3.PROJECT_LOGS,
      }) as ReturnType<Span["getParentInfo"]>,
    id: "row-id",
    rootSpanId: "root-span-id",
    spanId: "span-id",
  } as unknown as Span;
}

describe("HarnessAgent continuation context", () => {
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
    const exportSpan = vi.fn();
    const span = serializableSpan(exportSpan);
    registerHarnessTurnSpan({ session, span });
    expect(exportSpan).not.toHaveBeenCalled();

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

    // Context injection must not enumerate unrelated lifecycle state.
    expect(suspended[contextKey]).toMatchObject({
      parent: expect.any(String),
      sessionId: "session-1",
      signature: expect.any(String),
    });

    await expect(session.detach()).resolves.toBe(detached);
    expect(detachedContinuation[contextKey]).toMatchObject({
      parent: expect.any(String),
      sessionId: "session-1",
      signature: expect.any(String),
    });

    await expect(session.stop()).resolves.toBe(stopped);
    expect(stoppedContinuation[contextKey]).toMatchObject({
      parent: detachedContinuation[contextKey]
        ? (detachedContinuation[contextKey] as { parent: string }).parent
        : undefined,
      sessionId: "session-1",
      signature: expect.any(String),
    });
    expect(exportSpan).not.toHaveBeenCalled();
  });

  test("never exports a turn span and contains lifecycle-state access", async () => {
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
    const exportSpan = vi.fn(() => new Promise<string>(() => {}));
    const span = serializableSpan(exportSpan);

    registerHarnessTurnSpan({ session, span });
    expect(exportSpan).not.toHaveBeenCalled();

    expect(session.suspendTurn()).toBe(suspendPromise);
    await expect(suspendPromise).resolves.toBe(suspended);
    expect(suspended).toHaveProperty(contextKey);
    await expect(session.detach()).resolves.toBe(resumeState);
    expect(exportSpan).not.toHaveBeenCalled();
  });

  test("authenticates and binds serialized parents to their session", async () => {
    const exportSpan = vi.fn();
    const parent = serializableSpan(exportSpan);
    const session = {
      sessionId: "bound-session",
      suspendTurn: async () => ({ cursor: 1 }),
    };
    registerHarnessTurnSpan({ session, span: parent });
    const continuation = await session.suspendTurn();
    const serialized = JSON.parse(JSON.stringify(continuation));
    const serializedParent = serialized[contextKey].parent;
    const otherParent = new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "other-project-id",
      row_id: "other-row-id",
      root_span_id: "other-root-span-id",
      span_id: "other-span-id",
    }).toStr();
    expect(exportSpan).not.toHaveBeenCalled();

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: serialized,
        sessionId: "bound-session",
      }),
    ).toBe(serializedParent);
    expect(
      captureHarnessCreateSessionParent({
        continueFrom: serialized,
        sessionId: "bound-session",
      }),
    ).toBe(serializedParent);

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: { ...serialized, cursor: 2 },
        sessionId: "bound-session",
      }),
    ).toBe(serializedParent);
    expect(
      captureHarnessCreateSessionParent({
        continueFrom: serialized,
        sessionId: "different-session",
      }),
    ).toBeUndefined();

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: {
          ...serialized,
          [contextKey]: {
            ...serialized[contextKey],
            parent: otherParent,
          },
        },
        sessionId: "bound-session",
      }),
    ).toBeUndefined();

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: {
          ...serialized,
          [contextKey]: {
            ...serialized[contextKey],
            sessionId: "attacker-session",
          },
        },
        sessionId: "attacker-session",
      }),
    ).toBeUndefined();

    expect(
      captureHarnessCreateSessionParent({
        continueFrom: {
          [contextKey]: {
            parent: otherParent,
            sessionId: "bound-session",
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

  test("updates and extends trusted local parents", () => {
    const log = vi.fn();
    const parent = { log } as unknown as Span;

    updateHarnessTurn(parent, {
      metrics: { completion_tokens: 2, prompt_tokens: 3, tokens: 5 },
      output: "finished",
    });
    endHarnessTurn(parent);

    expect(log).toHaveBeenNthCalledWith(1, { output: null });
    expect(log).toHaveBeenNthCalledWith(2, {
      metrics: {
        completion_tokens: 2,
        prompt_tokens: 3,
        tokens: 5,
      },
      output: "finished",
    });
    expect(log).toHaveBeenNthCalledWith(3, {
      metrics: { end: expect.any(Number) },
    });
  });
});
