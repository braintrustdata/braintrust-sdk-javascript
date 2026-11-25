import { expect, test, vi } from "vite-plus/test";

test("flush does not initialize an unused SDK", async () => {
  const key = Symbol.for("braintrust-state-v4");
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const previous = globals[key];
  delete globals[key];
  const legacyState = { bgLogger: vi.fn() };
  vi.stubGlobal(Symbol.for("braintrust-state"), legacyState);
  vi.resetModules();
  try {
    const sdk = await import("./core");
    await sdk.flush();
    expect(globals[key]).toBeUndefined();
    expect(sdk._internalGetGlobalState()).not.toBe(legacyState);
    expect(legacyState.bgLogger).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete globals[key];
    if (previous !== undefined) globals[key] = previous;
  }
});

test("flush finds state initialized by another SDK copy", async () => {
  const first = await import("./core");
  const logger = first._internalGetGlobalState().bgLogger();
  const flush = vi.spyOn(logger, "flush").mockResolvedValue(undefined);
  vi.resetModules();
  try {
    const second = await import("./core");
    await second.flush();
    expect(flush).toHaveBeenCalledOnce();
  } finally {
    flush.mockRestore();
  }
});
