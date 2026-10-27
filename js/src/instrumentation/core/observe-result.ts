import { debugLogger } from "../../debug-logger";

/** Contain observation failures without retrying or replacing the provider call. */
export function runInstrumentation<T>(observe: () => T): T | undefined {
  try {
    const value = observe();
    if (value instanceof Promise)
      void value.catch((error) => {
        debugLogger.error("Error observing provider call:", error);
      });
    return value;
  } catch (error) {
    debugLogger.error("Error observing provider call:", error);
    return undefined;
  }
}

/** Observe settlement while preserving the original value and Promise helpers. */
export function observeResult<T>(
  result: T,
  fulfilled: (value: Awaited<T>) => void,
  rejected: (error: unknown) => void,
): T {
  runInstrumentation(() => {
    const then =
      result != null &&
      (typeof result === "object" || typeof result === "function")
        ? Reflect.get(result, "then")
        : undefined;
    if (typeof then !== "function") {
      fulfilled(result as Awaited<T>);
      return;
    }
    // Call then directly: Promise.resolve would defer observing foreign thenables.
    const observed = Reflect.apply(then, result, [
      (value: Awaited<T>) => runInstrumentation(() => fulfilled(value)),
      (error: unknown) => runInstrumentation(() => rejected(error)),
    ]);
    if (observed != null && typeof observed.then === "function") {
      observed.then(undefined, () => {});
    }
  });
  return result;
}
