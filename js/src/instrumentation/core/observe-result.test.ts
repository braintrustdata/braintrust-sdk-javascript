import { describe, expect, it, vi } from "vitest";
import { observeResult } from "./observe-result";

vi.mock("../../debug-logger", () => ({ debugLogger: { error: vi.fn() } }));

describe("observeResult", () => {
  it("preserves Promise subclasses and their helper methods", async () => {
    class ProviderPromise extends Promise<string> {
      requestId = "request-1";
    }
    const promise = new ProviderPromise((resolve) => resolve("response"));
    const fulfilled = vi.fn();
    expect(observeResult(promise, fulfilled, vi.fn())).toBe(promise);
    await promise;
    expect(promise.requestId).toBe("request-1");
    expect(fulfilled).toHaveBeenCalledExactlyOnceWith("response");
  });

  it("does not replace a provider rejection when an observer throws", async () => {
    const error = new Error("provider failed");
    const promise = Promise.reject(error);
    expect(
      observeResult(promise, vi.fn(), () => {
        throw new Error("observer failed");
      }),
    ).toBe(promise);
    await expect(promise).rejects.toBe(error);
  });

  it("contains asynchronous observer failures", async () => {
    const promise = Promise.resolve("response");
    observeResult(
      promise,
      async () => {
        throw new Error("observer failed");
      },
      vi.fn(),
    );
    await expect(promise).resolves.toBe("response");
    await Promise.resolve();
  });

  it("contains a throwing then getter without altering the return value", () => {
    const result = {
      get then(): never {
        throw new Error("not a promise");
      },
    };
    expect(observeResult(result, vi.fn(), vi.fn())).toBe(result);
  });

  it("observes synchronous results without making them asynchronous", () => {
    const result = { content: "response" };
    const fulfilled = vi.fn();
    expect(observeResult(result, fulfilled, vi.fn())).toBe(result);
    expect(fulfilled).toHaveBeenCalledExactlyOnceWith(result);
  });
});
