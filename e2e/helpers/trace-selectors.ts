import type { CapturedLogEvent } from "./mock-braintrust-server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mergeValue(base: unknown, incoming: unknown): unknown {
  if (incoming === undefined) {
    return clone(base);
  }

  if (isRecord(base) && isRecord(incoming)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }

  return clone(incoming);
}

function mergeEvent(
  existing: CapturedLogEvent | undefined,
  incoming: CapturedLogEvent,
): CapturedLogEvent {
  if (!existing) {
    return clone(incoming);
  }

  return mergeValue(existing, incoming) as CapturedLogEvent;
}

function latestEventsPerSpan(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const orderedSpanIds: string[] = [];
  const latestBySpanId = new Map<string, CapturedLogEvent>();
  const withoutSpanId: CapturedLogEvent[] = [];

  for (const event of events) {
    if (event.span.id) {
      if (!latestBySpanId.has(event.span.id)) {
        orderedSpanIds.push(event.span.id);
      }
      latestBySpanId.set(
        event.span.id,
        mergeEvent(latestBySpanId.get(event.span.id), event),
      );
      continue;
    }

    withoutSpanId.push(event);
  }

  return [
    ...orderedSpanIds.flatMap((spanId) => {
      const event = latestBySpanId.get(spanId);
      return event ? [event] : [];
    }),
    ...withoutSpanId,
  ];
}

function findLatestEvent(
  events: CapturedLogEvent[],
  predicate: (event: CapturedLogEvent) => boolean,
): CapturedLogEvent | undefined {
  return [...events].reverse().find(predicate);
}

export function findLatestSpan(
  events: CapturedLogEvent[],
  name: string,
): CapturedLogEvent | undefined {
  return findLatestEvent(events, (event) => event.span.name === name);
}

export function findAllSpans(
  events: CapturedLogEvent[],
  name: string,
): CapturedLogEvent[] {
  return latestEventsPerSpan(
    events.filter((event) => event.span.name === name),
  );
}

export function findChildSpans(
  events: CapturedLogEvent[],
  name: string,
  parentId: string | undefined,
): CapturedLogEvent[] {
  if (!parentId) {
    return [];
  }

  return latestEventsPerSpan(
    events.filter(
      (event) =>
        event.span.name === name && event.span.parentIds.includes(parentId),
    ),
  );
}

export function findLatestChildSpan(
  events: CapturedLogEvent[],
  name: string,
  parentId: string | undefined,
): CapturedLogEvent | undefined {
  if (!parentId) {
    return undefined;
  }

  return (
    findLatestEvent(
      events,
      (event) =>
        event.span.name === name &&
        event.span.parentIds.includes(parentId) &&
        event.output !== undefined,
    ) ??
    findLatestEvent(
      events,
      (event) =>
        event.span.name === name && event.span.parentIds.includes(parentId),
    )
  );
}

export function spanInstrumentationName(
  event: CapturedLogEvent | undefined,
): string | undefined {
  const spanOrigin = event?.context?.span_origin;
  if (!isRecord(spanOrigin) || !isRecord(spanOrigin.instrumentation)) {
    return undefined;
  }
  return typeof spanOrigin.instrumentation.name === "string"
    ? spanOrigin.instrumentation.name
    : undefined;
}
