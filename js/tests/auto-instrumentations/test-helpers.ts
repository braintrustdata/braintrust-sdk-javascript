/** Test-local recording through ordinary invocation interceptors. */
import { newGlobalInvocationHook } from "../../src/global-instrumentation-hooks";

export interface CapturedEvent {
  arguments?: any[];
  self?: any;
  result?: any;
  error?: any;
  timestamp: number;
}
export function createEventCollector() {
  const removals: Array<() => void> = [];
  return {
    calls: [] as CapturedEvent[],
    returns: [] as CapturedEvent[],
    promises: [] as CapturedEvent[],
    resolutions: [] as CapturedEvent[],
    failures: [] as CapturedEvent[],
    clear() {
      this.calls = [];
      this.returns = [];
      this.promises = [];
      this.resolutions = [];
      this.failures = [];
    },
    subscribe(channelName: string) {
      removals.push(
        newGlobalInvocationHook(channelName).intercept(
          (target, receiver, args) => {
            this.calls.push({
              arguments: args,
              self: receiver,
              timestamp: Date.now(),
            });
            let result;
            try {
              result = Reflect.apply(target, receiver, args);
            } catch (error) {
              this.failures.push({ error, timestamp: Date.now() });
              throw error;
            }
            this.returns.push({ result, timestamp: Date.now() });
            if (result && typeof result.then === "function") {
              this.promises.push({ result, timestamp: Date.now() });
              result.then(
                (value: unknown) => {
                  this.resolutions.push({
                    result: value,
                    timestamp: Date.now(),
                  });
                },
                (error: unknown) => {
                  this.failures.push({ error, timestamp: Date.now() });
                },
              );
            }
            return result;
          },
        ),
      );
    },
    unsubscribe() {
      for (const remove of removals.splice(0)) remove();
    },
  };
}
export type EventCollector = ReturnType<typeof createEventCollector>;
export async function runAndCollectEvents<T>(
  fn: () => T | Promise<T>,
  _collector: EventCollector,
): Promise<T> {
  const result = await fn();
  await new Promise((resolve) => setImmediate(resolve));
  return result;
}
