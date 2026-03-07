import type { CapturedLogEvent } from "./mock-braintrust-server";

export function findLatestEvent(
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
