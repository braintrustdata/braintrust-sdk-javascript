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
  newGlobalInvocationHook: vi.fn(() => ({ invoke })),
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
      expect(invoke).not.toHaveBeenCalled();
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
    expect(invoke).toHaveBeenCalledTimes(1);
    expect({
      self: invoke.mock.calls[0]?.[1],
      arguments: invoke.mock.calls[0]?.[2],
    }).toEqual({
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

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves the history leaf and argument count used by current Think", async () => {
    class Think {
      _runInferenceLoop(...args: [unknown, string?]) {
        return Promise.resolve({ receiver: this, args });
      }
    }
    const sdk = wrapCloudflareThink({ Think });
    const instance = new sdk.Think();
    const input = { body: "continue this branch" };
    for (const args of [[input], [input, "history-leaf"]] as [
      unknown,
      string?,
    ][]) {
      await expect(instance._runInferenceLoop(...args)).resolves.toEqual({
        receiver: instance,
        args,
      });
    }
  });

  it("preserves promise identity and rejection", async () => {
    const error = new Error("inference failed");
    const result = Promise.reject(error);
    class Think {
      _runInferenceLoop() {
        return result;
      }
    }
    wrapCloudflareThink({ Think });
    expect(new Think()._runInferenceLoop()).toBe(result);
    await expect(result).rejects.toBe(error);
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
