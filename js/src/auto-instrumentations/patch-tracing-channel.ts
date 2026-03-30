/**
 * Patches TracingChannel.prototype to handle APIPromise and other Promise subclasses
 * that change the constructor signature (violating the species contract).
 *
 * node:diagnostics_channel's tracePromise wraps the result with Promise.resolve(),
 * which calls the subclass constructor with the wrong signature for classes like
 * Anthropic's APIPromise. This patch uses duck-typing (.then check) instead.
 *
 * This is applied both in the loader hook (hook.mts) for the --import path,
 * and in configureNode/configureBrowser for the bundler plugin path.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patchTracingChannel(
  tracingChannelFn: (name: string) => any,
): void {
  const dummyChannel = tracingChannelFn("__braintrust_probe__");
  const TracingChannel = dummyChannel?.constructor;

  if (!TracingChannel?.prototype) {
    return;
  }

  if (
    !Object.getOwnPropertyDescriptor(TracingChannel.prototype, "hasSubscribers")
  ) {
    Object.defineProperty(TracingChannel.prototype, "hasSubscribers", {
      configurable: true,
      enumerable: false,
      get(this: {
        start?: { hasSubscribers?: boolean };
        end?: { hasSubscribers?: boolean };
        asyncStart?: { hasSubscribers?: boolean };
        asyncEnd?: { hasSubscribers?: boolean };
        error?: { hasSubscribers?: boolean };
      }) {
        return Boolean(
          this.start?.hasSubscribers ||
          this.end?.hasSubscribers ||
          this.asyncStart?.hasSubscribers ||
          this.asyncEnd?.hasSubscribers ||
          this.error?.hasSubscribers,
        );
      },
    });
  }

  if (TracingChannel.prototype.tracePromise) {
    TracingChannel.prototype.tracePromise = function (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      context: any = {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thisArg: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...args: any[]
    ) {
      const { start, end, asyncStart, asyncEnd, error } = this;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function publishRejected(err: any) {
        context.error = err;
        error?.publish(context);
        asyncStart?.publish(context);
        asyncEnd?.publish(context);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function publishResolved(result: any) {
        context.result = result;
        asyncStart?.publish(context);
        asyncEnd?.publish(context);
      }

      // Use runStores (not just publish) so fn runs inside the ALS context
      // established by bindStore — required for span context to propagate across awaits.
      // PATCHED: inside the callback, use duck-type thenable check instead of
      // PromisePrototypeThen, which triggers Symbol.species and breaks Promise subclasses
      // like Anthropic's APIPromise that have non-standard constructors.
      return start.runStores(context, () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result: any = Reflect.apply(fn, thisArg, args);
          end?.publish(context);

          if (
            result &&
            (typeof result === "object" || typeof result === "function") &&
            typeof result.then === "function"
          ) {
            if (result.constructor === Promise) {
              return result.then(
                (res) => {
                  publishResolved(res);
                  return res;
                },
                (err) => {
                  publishRejected(err);
                  return Promise.reject(err);
                },
              );
            }

            // Preserve the original promise-like object so SDK helper methods
            // like Anthropic APIPromise.withResponse() remain available.
            void result.then(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (resolved: any) => {
                try {
                  publishResolved(resolved);
                } catch {
                  // Preserve wrapped promise semantics even if instrumentation fails.
                }
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (err: any) => {
                try {
                  publishRejected(err);
                } catch {
                  // Preserve wrapped promise semantics even if instrumentation fails.
                }
              },
            );

            return result;
          }

          context.result = result;
          asyncStart?.publish(context);
          asyncEnd?.publish(context);
          return result;
        } catch (err) {
          context.error = err;
          error?.publish(context);
          end?.publish(context);
          throw err;
        }
      });
    };
  }
}
