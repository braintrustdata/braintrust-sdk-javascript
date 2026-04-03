import {
  ContextManager,
  BRAINTRUST_CURRENT_SPAN_STORE,
  _internalIso as iso,
  type ContextParentSpanIds,
  type CurrentSpanStore,
  type Span,
} from "braintrust";

import { trace as otelTrace, context as otelContext } from "@opentelemetry/api";
import { getOtelParentFromSpan } from "./otel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BT_SPAN_KEY = "braintrust_span" as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BT_PARENT_KEY = "braintrust.parent" as any;

function isOtelSpan(span: unknown): span is {
  spanContext: () => { spanId: string; traceId: string };
} {
  return (
    typeof span === "object" &&
    span !== null &&
    "spanContext" in span &&
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Type guard ensures object has property
    typeof (span as { spanContext?: unknown }).spanContext === "function"
  );
}

function isBraintrustSpan(span: unknown): span is Span {
  return (
    typeof span === "object" &&
    span !== null &&
    "spanId" in span &&
    "rootSpanId" in span &&
    typeof span.spanId === "string"
  );
}

function isValidSpanContext(spanContext: unknown): boolean {
  if (
    !spanContext ||
    typeof spanContext !== "object" ||
    !("spanId" in spanContext) ||
    !("traceId" in spanContext)
  ) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const ctx = spanContext as { spanId: string; traceId: string };
  return (
    ctx.spanId !== "0000000000000000" &&
    ctx.traceId !== "00000000000000000000000000000000"
  );
}

/**
 * Builds an OTEL Context containing a NonRecordingSpan wrapper around the
 * Braintrust span's IDs, plus the BT span stored under BT_SPAN_KEY for
 * retrieval by getCurrentSpan().
 */
function buildBtOtelContext(span: Span): unknown {
  const btSpan = span as { spanId: string; rootSpanId: string };
  const spanContext = {
    traceId: btSpan.rootSpanId,
    spanId: btSpan.spanId,
    traceFlags: 1, // sampled
  };
  const wrappedSpan = otelTrace.wrapSpanContext(spanContext);
  const currentContext = otelContext.active();
  let newContext = otelTrace.setSpan(currentContext, wrappedSpan);
  newContext = newContext.setValue(BT_SPAN_KEY, span);

  if (isBraintrustSpan(span)) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const parentValue = getOtelParentFromSpan(span as never);
    if (parentValue) {
      newContext = newContext.setValue(BT_PARENT_KEY, parentValue);
    }
  }

  return newContext;
}

export class OtelContextManager extends ContextManager {
  /** Fallback ALS used when the OTEL context manager doesn't expose _asyncLocalStorage. */
  private _ownAls: CurrentSpanStore | undefined;

  private _getOtelAls(): CurrentSpanStore | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (otelContext as any)._getContextManager?.()._asyncLocalStorage;
  }

  constructor() {
    super();
    // Expose whichever ALS is in use via BRAINTRUST_CURRENT_SPAN_STORE so that
    // TracingChannel's bindStore can propagate span context. We prefer OTEL's own
    // ALS (AsyncLocalStorageContextManager._asyncLocalStorage) so that spans
    // stored by runStores are visible to OTEL's context APIs. If the active OTEL
    // context manager doesn't expose an ALS (e.g. AsyncHooksContextManager), we
    // fall back to our own IsoAsyncLocalStorage<Span> and behave like the default
    // BraintrustContextManager for TracingChannel binding.
    //
    // A lazy getter is required because the global OTEL context manager may not be
    // registered until after this instance is constructed.
    const self = this;
    Object.defineProperty(this, BRAINTRUST_CURRENT_SPAN_STORE, {
      get(): CurrentSpanStore {
        const otelAls = self._getOtelAls();
        if (otelAls) return otelAls;
        if (!self._ownAls) self._ownAls = iso.newAsyncLocalStorage<unknown>();
        return self._ownAls;
      },
      configurable: true,
      enumerable: false,
    });
  }

  wrapSpanForStore(span: Span): unknown {
    // When using OTEL's ALS the stored value must be an OTEL Context, not a raw
    // Span, so that OTEL's own context propagation sees a valid Context object.
    // When using our own fallback ALS we store the Span directly (default mode).
    if (this._getOtelAls()) return buildBtOtelContext(span);
    return span;
  }

  getParentSpanIds(): ContextParentSpanIds | undefined {
    const currentSpan = otelTrace.getActiveSpan();
    if (!currentSpan || !isOtelSpan(currentSpan)) {
      return undefined;
    }

    const spanContext = currentSpan.spanContext();
    if (!isValidSpanContext(spanContext)) {
      return undefined;
    }

    // Check if this is a wrapped BT span
    const btSpan = otelContext?.active().getValue?.(BT_SPAN_KEY);
    if (
      btSpan &&
      currentSpan.constructor.name === "NonRecordingSpan" &&
      typeof btSpan === "object" &&
      btSpan !== null &&
      "rootSpanId" in btSpan &&
      "spanId" in btSpan
    ) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const typedBtSpan = btSpan as { rootSpanId: string; spanId: string };
      return {
        rootSpanId: typedBtSpan.rootSpanId,
        spanParents: [typedBtSpan.spanId],
      };
    }

    // Otherwise use OTEL span IDs
    const otelTraceId = spanContext.traceId.toString().padStart(32, "0");
    const otelSpanId = spanContext.spanId.toString().padStart(16, "0");
    return {
      rootSpanId: otelTraceId,
      spanParents: [otelSpanId],
    };
  }

  runInContext<R>(span: Span, callback: () => R): R {
    try {
      if (isBraintrustSpan(span)) {
        return otelContext.with(
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          buildBtOtelContext(span) as Parameters<typeof otelContext.with>[0],
          callback,
        );
      }
    } catch (error) {
      console.warn("Failed to run in OTEL context:", error);
    }

    return callback();
  }

  getCurrentSpan(): Span | undefined {
    // Check OTEL context first — this covers both runInContext and the OTEL-ALS
    // TracingChannel path where runStores stores a Context under BT_SPAN_KEY.
    const btSpan = otelContext.active().getValue?.(BT_SPAN_KEY);
    if (
      btSpan &&
      typeof btSpan === "object" &&
      btSpan !== null &&
      "spanId" in btSpan &&
      "rootSpanId" in btSpan
    ) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return btSpan as Span;
    }

    // If we're using the fallback ALS (non-ALS OTEL context manager), spans are
    // stored directly in our own ALS by TracingChannel's runStores.
    if (this._ownAls) {
      const stored = this._ownAls.getStore();
      if (isBraintrustSpan(stored)) return stored;
    }

    return undefined;
  }
}
