import { registerInstrumentation } from "../instrumentation/registrations/workersAI";
import { workersAIChannels } from "../instrumentation/providers/workers-ai-interceptors";
import type { WorkersAI } from "../vendor-sdk-types/workers-ai";

const wrappedBindings = new WeakMap<object, object>();

/**
 * Trace Clef and Clairic calls on a Workers AI binding.
 * Other models and raw-response/streaming modes pass through unchanged.
 *
 * @example
 * ```ts
 * const ai = wrapWorkersAI(env.AI);
 * await ai.run("@cf/cloudflare/clef-flash", {
 *   model: "clef-flash",
 *   state: "Checkout is down",
 *   questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
 * });
 * ```
 */
export function wrapWorkersAI<T>(binding: T): T {
  registerInstrumentation();
  if (
    !binding ||
    typeof binding !== "object" ||
    typeof Reflect.get(binding, "run") !== "function"
  ) {
    return binding;
  }
  const cached = wrappedBindings.get(binding);
  if (cached) return cached as T;

  const ai = binding as T & WorkersAI;
  const methods = new Map<
    PropertyKey,
    { original: object; wrapped: (...args: never[]) => unknown }
  >();
  const proxy = new Proxy(ai, {
    get(target, property) {
      // Native binding methods and getters use private fields. Always retain
      // the original receiver, including methods outside the traced surface.
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || property === "constructor")
        return value;
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      if (descriptor && !descriptor.configurable && !descriptor.writable) {
        return value;
      }
      const cachedMethod = methods.get(property);
      if (cachedMethod?.original === value) return cachedMethod.wrapped;
      const method =
        property === "run"
          ? (...args: Parameters<WorkersAI["run"]>) =>
              workersAIChannels.run.invoke(
                value as WorkersAI["run"],
                target,
                args,
                {},
              )
          : value.bind(target);
      methods.set(property, { original: value, wrapped: method });
      return method;
    },
  });
  wrappedBindings.set(ai, proxy);
  wrappedBindings.set(proxy, proxy);
  return proxy;
}
