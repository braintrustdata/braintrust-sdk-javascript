/**
 * @example
 * isObject([1, 2, 3]) // false
 */
export function isObject(value: unknown): value is { [key: string]: unknown } {
  return value instanceof Object && !(value instanceof Array);
}

export function isArray(value: unknown): value is unknown[] {
  return value instanceof Array;
}

export function isObjectOrArray(
  value: unknown,
): value is { [key: string]: unknown } {
  return value instanceof Object;
}

export function isEmpty(a: unknown): a is null | undefined {
  return a === undefined || a === null;
}

export function notEmpty<T>(a: T | null | undefined): T {
  if (!isEmpty(a)) {
    return a;
  } else {
    throw new Error(`Unexpected empty value ${a}`);
  }
}

export function isNumber(a: unknown): a is number | bigint {
  return typeof a === "number" || typeof a === "bigint";
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
