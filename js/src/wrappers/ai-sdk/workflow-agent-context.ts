import { _internalGetGlobalState, type Span } from "../../logger";

const workflowAgentWrapperSpans = new Map<string, Span>();

export function registerWorkflowAgentWrapperSpan(span: Span): void {
  if (span.spanId) {
    workflowAgentWrapperSpans.set(span.spanId, span);
  }
}

export function unregisterWorkflowAgentWrapperSpan(span: Span): void {
  if (span.spanId) {
    workflowAgentWrapperSpans.delete(span.spanId);
  }
}

export function workflowAgentWrapperSpanCountForTesting(): number {
  return workflowAgentWrapperSpans.size;
}

export function currentWorkflowAgentWrapperSpan(): Span | undefined {
  const parentSpanIds =
    _internalGetGlobalState().contextManager.getParentSpanIds()?.spanParents ??
    [];
  for (const parentSpanId of parentSpanIds) {
    const span = workflowAgentWrapperSpans.get(parentSpanId);
    if (span) {
      return span;
    }
  }

  return undefined;
}
