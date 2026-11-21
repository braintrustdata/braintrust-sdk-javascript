import { isObject } from "../../util";

/** Observe Retell's raw response without consuming the caller's body. */
export function observeRetellResponse(
  result: PromiseLike<unknown>,
): PromiseLike<unknown> {
  if (
    !isObject(result) ||
    typeof result.asResponse !== "function" ||
    typeof result.withResponse !== "function"
  )
    return result;
  const helpers = new Map<string, (...args: unknown[]) => unknown>();
  for (const key of [
    "then",
    "catch",
    "finally",
    "asResponse",
    "withResponse",
  ]) {
    const method = Reflect.get(result, key);
    if (typeof method !== "function") return Promise.resolve(undefined);
    helpers.set(key, (...args: unknown[]) =>
      Reflect.apply(method, result, args),
    );
  }
  const captured = Promise.resolve(
    Reflect.apply(helpers.get("asResponse")!, result, []),
  ).then((response: unknown) => {
    if (!(response instanceof Response)) return undefined;
    try {
      return response
        .clone()
        .json()
        .catch(() => undefined);
    } catch {
      return undefined;
    }
  });
  // As in the TypeSafe integration, wait before the SDK parses the original
  // body. Raw-response callers can then read it, and flush sees the completed
  // trace. Keep the SDK promise itself and every original helper result/error.
  const settled = captured.then(
    () => undefined,
    () => undefined,
  );
  for (const [key, method] of helpers) {
    Object.defineProperty(result, key, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) =>
        settled.then(() => Reflect.apply(method, result, args)),
    });
  }
  return captured;
}
