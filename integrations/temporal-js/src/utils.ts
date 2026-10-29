import type { Payload } from "@temporalio/common";
import type { PropagationContext } from "braintrust";

const TRACE_CONTEXT_HEADERS = ["traceparent", "tracestate", "baggage"] as const;

export function serializeHeaderValue(value: string): Payload {
  return {
    metadata: {
      encoding: new TextEncoder().encode("json/plain"),
    },
    data: new TextEncoder().encode(JSON.stringify(value)),
  };
}

export function deserializeHeaderValue(
  payload: Payload | undefined,
): string | undefined {
  if (!payload?.data) {
    return undefined;
  }
  try {
    const decoded = new TextDecoder().decode(payload.data);
    return JSON.parse(decoded);
  } catch {
    return undefined;
  }
}

export function serializeTraceContext(
  context: PropagationContext,
): Record<string, Payload> {
  return Object.fromEntries(
    TRACE_CONTEXT_HEADERS.flatMap((name) => {
      const value = context[name];
      return value ? [[name, serializeHeaderValue(value)]] : [];
    }),
  );
}

export function deserializeTraceContext(
  headers: Record<string, Payload> | undefined,
): PropagationContext | undefined {
  if (!headers) return undefined;
  const context = Object.fromEntries(
    TRACE_CONTEXT_HEADERS.flatMap((name) => {
      const value = deserializeHeaderValue(headers[name]);
      return value ? [[name, value]] : [];
    }),
  );
  return context.traceparent ? context : undefined;
}

export function withParentSpanId(
  context: PropagationContext,
  spanId: string,
): PropagationContext | undefined {
  const match = context.traceparent.match(
    /^([0-9a-f]{2})-([0-9a-f]{32})-[0-9a-f]{16}-([0-9a-f]{2})$/,
  );
  if (!match) return undefined;
  return {
    ...context,
    traceparent: `${match[1]}-${match[2]}-${spanId}-${match[3]}`,
  };
}
