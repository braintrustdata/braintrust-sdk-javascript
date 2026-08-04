import { debugLogger } from "../debug-logger";

const sessionStreamCollectors = new WeakMap<object, () => void>();

export function registerAnthropicSessionStreamCollector(
  stream: object,
  collector: () => void,
): void {
  sessionStreamCollectors.set(stream, collector);
}

/**
 * Collect a stream returned by `anthropic.beta.sessions.events.stream()` or
 * `anthropic.beta.sessions.threads.events.stream()`.
 *
 * The stream method must be auto-instrumented or called through a client
 * wrapped with `wrapAnthropic()`. Calling this function opts the stream into
 * Braintrust span collection and returns the original stream unchanged.
 *
 * @param stream The resolved Anthropic Sessions event stream.
 * @returns The same stream object.
 */
export function collectAnthropicSession<T extends object>(stream: T): T {
  const collector = sessionStreamCollectors.get(stream);
  if (!collector) {
    return stream;
  }

  sessionStreamCollectors.delete(stream);
  try {
    collector();
  } catch (error) {
    debugLogger.error("Failed to collect Anthropic Sessions stream:", error);
  }
  return stream;
}
