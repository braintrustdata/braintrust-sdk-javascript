import { _internalGetGlobalState, type Span } from "../../logger";

const cloudflareThinkSpans = new Map<string, Span>();

export function registerCloudflareThinkSpan(span: Span): void {
  if (span.spanId) {
    cloudflareThinkSpans.set(span.spanId, span);
  }
}

export function unregisterCloudflareThinkSpan(span: Span): void {
  if (span.spanId) {
    cloudflareThinkSpans.delete(span.spanId);
  }
}

export function currentCloudflareThinkSpan(): Span | undefined {
  const parentSpanIds =
    _internalGetGlobalState().contextManager.getParentSpanIds()?.spanParents ??
    [];
  for (const parentSpanId of parentSpanIds) {
    const span = cloudflareThinkSpans.get(parentSpanId);
    if (span) {
      return span;
    }
  }
  return undefined;
}

export function cloudflareThinkSpanCountForTesting(): number {
  return cloudflareThinkSpans.size;
}
