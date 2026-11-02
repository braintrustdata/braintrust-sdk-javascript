import { _internalGetGlobalState, type Span } from "../../logger/core";

export type CloudflareThinkRun = {
  span: Span;
  startTelemetry: (
    input: unknown,
    metadata: Record<string, unknown>,
  ) => boolean;
  finishTelemetry: (
    output: unknown,
    metrics: Record<string, number>,
    error?: unknown,
  ) => void;
};

const THINK_SPANS = Symbol.for("braintrust.cloudflare-think.spans.v1");

// The AI SDK and Think consumers may be registered by different bundled copies.
// Keep their active spans together, just like the global instrumentation registry.
function getThinkSpans(): Map<string, CloudflareThinkRun> {
  const root = globalThis as typeof globalThis & {
    [THINK_SPANS]?: Map<string, CloudflareThinkRun>;
  };
  return (root[THINK_SPANS] ??= new Map());
}

export function registerCloudflareThinkSpan(run: CloudflareThinkRun): void {
  if (run.span.spanId) {
    getThinkSpans().set(run.span.spanId, run);
  }
}

export function unregisterCloudflareThinkSpan(span: Span): void {
  if (span.spanId) {
    getThinkSpans().delete(span.spanId);
  }
}

export function currentCloudflareThinkRun(): CloudflareThinkRun | undefined {
  const parentSpanIds =
    _internalGetGlobalState()?.contextManager.getParentSpanIds()?.spanParents ??
    [];
  for (const parentSpanId of parentSpanIds) {
    const span = getThinkSpans().get(parentSpanId);
    if (span) {
      return span;
    }
  }
  return undefined;
}

export function cloudflareThinkSpanCountForTesting(): number {
  return getThinkSpans().size;
}
