import {
  ContextManager,
  extractTraceContextFromHeaders,
  type ContextParentSpanIds,
  type CurrentSpanStore,
  type Span,
} from "braintrust";
import {
  context,
  trace,
  createContextKey,
  createTraceState,
  isSpanContextValid,
  type Context,
} from "@opentelemetry/api";
import { addParentToBaggage, getOtelParentFromSpan } from "./otel";

const BRAINTRUST_SPAN_KEY = createContextKey("braintrust.span");

function contextWithSpan(span: Span): Context {
  const headers = extractTraceContextFromHeaders(span.inject());
  const ctx = trace
    .setSpanContext(context.active(), {
      traceId: span.rootSpanId,
      spanId: span.spanId,
      traceFlags: headers ? parseInt(headers.traceparent.split("-")[3], 16) : 1,
      ...(headers?.tracestate
        ? { traceState: createTraceState(headers.tracestate) }
        : {}),
    })
    .setValue(BRAINTRUST_SPAN_KEY, span);
  const parent = getOtelParentFromSpan(span);
  return parent ? addParentToBaggage(parent, ctx) : ctx;
}

/** Bridge through the registered OTel context manager's public API. */
export class OtelContextManager extends ContextManager {
  private readonly store: CurrentSpanStore = {
    getStore: () => context.active(),
    // CurrentSpanStore erases the value type. wrapSpanForStore supplies Context.
    run: (value, callback) =>
      context.with(
        (value as Context | undefined) ?? context.active(),
        callback,
      ),
  };

  getCurrentSpanStore(): CurrentSpanStore {
    return this.store;
  }

  wrapSpanForStore(span: Span): Context {
    return contextWithSpan(span);
  }

  getParentSpanIds(): ContextParentSpanIds | undefined {
    const parent = trace.getSpanContext(context.active());
    if (!parent || !isSpanContextValid(parent)) return undefined;
    return {
      rootSpanId: parent.traceId,
      spanParents: [parent.spanId],
      traceFlags: parent.traceFlags,
      traceState: parent.traceState?.serialize(),
    };
  }

  runInContext<R>(span: Span, callback: () => R): R {
    return context.with(contextWithSpan(span), callback);
  }

  getCurrentSpan(): Span | undefined {
    return context.active().getValue(BRAINTRUST_SPAN_KEY) as Span | undefined;
  }
}
