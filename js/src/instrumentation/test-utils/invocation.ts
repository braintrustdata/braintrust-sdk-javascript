import type { GlobalInvocationInterceptor } from "../../global-instrumentation-hooks";

type Call = {
  arguments?: unknown[];
  self?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

/** Drive a real interceptor with controllable provider settlement, without tracing events. */
export function invocationController(interceptor: GlobalInvocationInterceptor) {
  const pending = new WeakMap<
    Call,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  return {
    begin(call: Call) {
      const result = {
        then(
          resolve: (value: unknown) => void,
          reject: (error: unknown) => void,
        ) {
          pending.set(call, { resolve, reject });
        },
      };
      return interceptor(() => result, call.self, call.arguments ?? [], call);
    },
    resolve(call: Call) {
      const operation = pending.get(call);
      if (!operation) return;
      pending.delete(call);
      return operation.resolve(call.result);
    },
    reject(call: Call) {
      const operation = pending.get(call);
      if (!operation) return;
      pending.delete(call);
      return operation.reject(call.error);
    },
    call(call: Call, target = () => call.result) {
      return interceptor(target, call.self, call.arguments ?? [], call);
    },
    throw(call: Call) {
      try {
        interceptor(
          () => {
            throw call.error;
          },
          call.self,
          call.arguments ?? [],
          call,
        );
      } catch (error) {
        if (error !== call.error) throw error;
        return;
      }
      throw new Error("Interceptor swallowed the provider error");
    },
  };
}
