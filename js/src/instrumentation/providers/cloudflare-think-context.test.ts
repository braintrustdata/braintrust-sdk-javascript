import { expect, test, vi } from "vite-plus/test";
import { _internalGetGlobalState, NoopSpan } from "../../logger/core";

test("shares active Think spans between separately loaded provider consumers", async () => {
  const first = await import("./cloudflare-think-context");
  vi.resetModules();
  const second = await import("./cloudflare-think-context");
  const span = new NoopSpan();
  span.spanId = "think-cross-bundle-test";

  first.registerCloudflareThinkSpan({
    span,
    startTelemetry: vi.fn(),
    finishTelemetry: vi.fn(),
  });
  try {
    _internalGetGlobalState().contextManager.runInContext(span, () => {
      expect(second.currentCloudflareThinkRun()?.span).toBe(span);
    });
    second.unregisterCloudflareThinkSpan(span);
    expect(first.cloudflareThinkSpanCountForTesting()).toBe(0);
  } finally {
    first.unregisterCloudflareThinkSpan(span);
  }
});
