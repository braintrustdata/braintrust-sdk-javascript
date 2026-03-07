import type {
  CapturedLogEvent,
  CapturedRequest,
  JsonValue,
} from "./mock-braintrust-server";
import type { Json } from "./normalize";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeEvent(event: CapturedLogEvent): Json {
  const row = event.row as Record<string, unknown>;
  const error =
    typeof row.error === "string"
      ? row.error.split("\n\n")[0]
      : row.error == null
        ? null
        : String(row.error);

  return {
    error,
    input: (row.input ?? null) as Json,
    metadata: (row.metadata ?? null) as Json,
    name: event.span.name ?? null,
    output: (row.output ?? null) as Json,
    span_attributes: (row.span_attributes ?? null) as Json,
    span_id: (row.span_id ?? null) as Json,
    span_parents: (row.span_parents ?? null) as Json,
    root_span_id: (row.root_span_id ?? null) as Json,
  };
}

export function summarizeRequest(
  request: CapturedRequest,
  options: {
    includeHeaders?: string[];
    normalizeJsonRawBody?: boolean;
  } = {},
): Json {
  const headers =
    options.includeHeaders && options.includeHeaders.length > 0
      ? Object.fromEntries(
          options.includeHeaders.flatMap((key) => {
            const value = request.headers[key];
            return value === undefined ? [] : [[key, value]];
          }),
        )
      : null;

  return {
    headers:
      headers && Object.keys(headers).length > 0 ? (headers as Json) : null,
    jsonBody: (request.jsonBody ?? null) as Json,
    method: request.method,
    path: request.path,
    query:
      Object.keys(request.query).length === 0 ? null : (request.query as Json),
    rawBody:
      options.normalizeJsonRawBody && request.jsonBody
        ? (request.jsonBody as Json)
        : request.rawBody || null,
  };
}

function otlpAttributeValue(value: unknown): Json {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.stringValue === "string") {
    return value.stringValue;
  }
  if (typeof value.boolValue === "boolean") {
    return value.boolValue;
  }
  if (typeof value.intValue === "string") {
    return value.intValue;
  }
  if (typeof value.doubleValue === "number") {
    return value.doubleValue;
  }
  const arrayValues =
    isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)
      ? value.arrayValue.values
      : undefined;
  if (arrayValues) {
    return arrayValues.map((entry: unknown) => otlpAttributeValue(entry));
  }

  return null;
}

export type OtlpSpanSummary = {
  attributes: Record<string, Json>;
  name: string;
  parentSpanId?: string;
  spanId?: string;
  traceId?: string;
};

export function extractOtelSpans(body: JsonValue | null): OtlpSpanSummary[] {
  if (!isRecord(body) || !Array.isArray(body.resourceSpans)) {
    return [];
  }

  const spans: OtlpSpanSummary[] = [];
  for (const resourceSpan of body.resourceSpans) {
    if (!isRecord(resourceSpan) || !Array.isArray(resourceSpan.scopeSpans)) {
      continue;
    }

    for (const scopeSpan of resourceSpan.scopeSpans) {
      if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans)) {
        continue;
      }

      for (const span of scopeSpan.spans) {
        if (!isRecord(span) || typeof span.name !== "string") {
          continue;
        }

        const attributes: Record<string, Json> = {};
        if (Array.isArray(span.attributes)) {
          for (const attribute of span.attributes) {
            if (!isRecord(attribute) || typeof attribute.key !== "string") {
              continue;
            }
            attributes[attribute.key] = otlpAttributeValue(attribute.value);
          }
        }

        spans.push({
          attributes,
          name: span.name,
          parentSpanId:
            typeof span.parentSpanId === "string"
              ? span.parentSpanId
              : undefined,
          spanId: typeof span.spanId === "string" ? span.spanId : undefined,
          traceId: typeof span.traceId === "string" ? span.traceId : undefined,
        });
      }
    }
  }

  return spans;
}
