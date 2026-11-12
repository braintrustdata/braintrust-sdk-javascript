import { currentSpan } from "../../logger/core";
import type { Span } from "../../logger/core";

function proxyAssertion(
  assertion: object,
  value: unknown,
  key: string,
  span: Span,
): unknown {
  return new Proxy(assertion, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);

      if (typeof original === "function") {
        return function (...args: unknown[]) {
          let result: unknown;
          try {
            result = original.apply(target, args);
          } catch (err) {
            span.log({ output: { [key]: value }, scores: { [key]: 0 } });
            throw err;
          }

          if (
            result !== null &&
            typeof result === "object" &&
            "then" in result &&
            typeof Reflect.get(result, "then") === "function"
          ) {
            return Promise.resolve(result).then(
              (v) => {
                span.log({ output: { [key]: value }, scores: { [key]: 1 } });
                return v;
              },
              (err) => {
                span.log({ output: { [key]: value }, scores: { [key]: 0 } });
                throw err;
              },
            );
          }

          span.log({ output: { [key]: value }, scores: { [key]: 1 } });
          return result;
        };
      }

      if (original !== null && typeof original === "object") {
        return proxyAssertion(original, value, key, span);
      }

      return original;
    },
  });
}

export function wrapExpect<
  ExpectType extends (value: unknown, message?: string) => unknown,
>(originalExpect: ExpectType): ExpectType {
  const wrapped = function (value: unknown, message?: string) {
    // pass through unnamed expect
    if (message === undefined) {
      return originalExpect(value);
    }

    const assertion = originalExpect(value, message);

    const span = currentSpan();
    if (!span) {
      return assertion;
    }

    if (assertion === null || typeof assertion !== "object") return assertion;
    return proxyAssertion(assertion, value, message, span);
  };

  return Object.assign(wrapped, originalExpect);
}
