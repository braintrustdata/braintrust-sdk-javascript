import { afterEach, describe, expect, it, vi } from "vitest";

const { tracePromise } = vi.hoisted(() => ({
  tracePromise: vi.fn((fn: () => unknown, _event?: unknown) => fn()),
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

import { wrapCloudflareThink } from "./cloudflare-think";

describe("wrapCloudflareThink", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([null, undefined, "think", {}, { Think: class {} }])(
    "returns unsupported module %j unchanged",
    (sdk) => {
      expect(wrapCloudflareThink(sdk)).toBe(sdk);
      expect(tracePromise).not.toHaveBeenCalled();
    },
  );

  it("traces _runInferenceLoop without changing its result or receiver", async () => {
    class Think {
      readonly marker = "think-instance";

      async _runInferenceLoop(input: { body: unknown }) {
        return { input, marker: this.marker };
      }
    }
    const sdk = { Think, helper: () => "unchanged" };

    expect(wrapCloudflareThink(sdk)).toBe(sdk);
    const instance = new sdk.Think();
    const input = { body: { messages: [] } };
    await expect(instance._runInferenceLoop(input)).resolves.toEqual({
      input,
      marker: "think-instance",
    });
    expect(tracePromise).toHaveBeenCalledTimes(1);
    expect(tracePromise.mock.calls[0]?.[1]).toEqual({
      arguments: [input],
      self: instance,
    });
    expect(sdk.helper()).toBe("unchanged");
  });

  it("is idempotent", async () => {
    class Think {
      async _runInferenceLoop(input: unknown) {
        return input;
      }
    }
    const sdk = { Think };

    wrapCloudflareThink(wrapCloudflareThink(sdk));
    await new sdk.Think()._runInferenceLoop("hello");

    expect(tracePromise).toHaveBeenCalledTimes(1);
  });

  it("preserves the original method descriptor", () => {
    class Think {}
    const original = vi.fn(async () => "ok");
    Object.defineProperty(Think.prototype, "_runInferenceLoop", {
      configurable: true,
      enumerable: false,
      value: original,
      writable: false,
    });

    wrapCloudflareThink({ Think });

    expect(
      Object.getOwnPropertyDescriptor(Think.prototype, "_runInferenceLoop"),
    ).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: false,
    });
  });
});
