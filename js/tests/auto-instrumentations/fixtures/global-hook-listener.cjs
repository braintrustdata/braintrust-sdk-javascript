const hooks =
  globalThis.__braintrust_instrumentation_hooks ??
  (() => {
    const registry = new Map();
    Object.defineProperty(globalThis, "__braintrust_instrumentation_hooks", {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    return registry;
  })();

function phase(name) {
  const subscribers = [];
  const stores = new Map();
  return {
    name,
    get hasSubscribers() {
      return subscribers.length > 0 || stores.size > 0;
    },
    bindStore(store, transform) {
      stores.set(store, transform);
    },
    unbindStore(store) {
      return stores.delete(store);
    },
    publish(message) {
      for (const subscriber of subscribers) subscriber(message, name);
    },
    runStores(message, fn) {
      let run = () => {
        this.publish(message);
        return fn();
      };
      for (const [store, transform] of stores) {
        const next = run;
        run = () => store.run(transform ? transform(message) : message, next);
      }
      return run();
    },
    subscribe(subscriber) {
      subscribers.push(subscriber);
    },
    unsubscribe(subscriber) {
      const index = subscribers.indexOf(subscriber);
      if (index === -1) return false;
      subscribers.splice(index, 1);
      return true;
    },
  };
}

function getTracingHook(channelName) {
  let hook = hooks.get(channelName);
  if (hook) return hook;

  hook = {
    start: phase(`tracing:${channelName}:start`),
    end: phase(`tracing:${channelName}:end`),
    asyncStart: phase(`tracing:${channelName}:asyncStart`),
    asyncEnd: phase(`tracing:${channelName}:asyncEnd`),
    error: phase(`tracing:${channelName}:error`),
    get hasSubscribers() {
      return (
        this.start.hasSubscribers ||
        this.end.hasSubscribers ||
        this.asyncStart.hasSubscribers ||
        this.asyncEnd.hasSubscribers ||
        this.error.hasSubscribers
      );
    },
    subscribe(handlers) {
      for (const name of ["start", "end", "asyncStart", "asyncEnd", "error"]) {
        if (handlers[name]) this[name].subscribe(handlers[name]);
      }
    },
    unsubscribe(handlers) {
      let done = true;
      for (const name of ["start", "end", "asyncStart", "asyncEnd", "error"]) {
        if (handlers[name] && !this[name].unsubscribe(handlers[name])) {
          done = false;
        }
      }
      return done;
    },
    traceSync(fn, message) {
      return this.start.runStores(message, () => {
        try {
          message.result = fn();
          return message.result;
        } catch (error) {
          message.error = error;
          this.error.publish(message);
          throw error;
        } finally {
          this.end.publish(message);
        }
      });
    },
    tracePromise(fn, message) {
      return this.start.runStores(message, () => {
        try {
          const result = fn();
          if (typeof result?.then !== "function") {
            message.result = result;
            this.end.publish(message);
            return result;
          }
          this.end.publish(message);
          return result.then(
            (value) => {
              message.result = value;
              this.asyncStart.publish(message);
              this.asyncEnd.publish(message);
              return value;
            },
            (error) => {
              message.error = error;
              this.error.publish(message);
              this.asyncStart.publish(message);
              this.asyncEnd.publish(message);
              throw error;
            },
          );
        } catch (error) {
          message.error = error;
          this.error.publish(message);
          this.end.publish(message);
          throw error;
        }
      });
    },
    traceCallback(fn, position, message) {
      const callback = Array.prototype.at.call(message.arguments, position);
      if (typeof callback !== "function") return fn();
      const currentHook = this;
      function wrappedCallback(error, result) {
        if (error) {
          message.error = error;
          currentHook.error.publish(message);
        } else {
          message.result = result;
        }
        return currentHook.asyncStart.runStores(message, () => {
          try {
            return callback.apply(this, arguments);
          } finally {
            currentHook.asyncEnd.publish(message);
          }
        });
      }
      Array.prototype.splice.call(
        message.arguments,
        position,
        1,
        wrappedCallback,
      );
      return this.start.runStores(message, () => {
        try {
          return fn();
        } catch (error) {
          message.error = error;
          this.error.publish(message);
          throw error;
        } finally {
          this.end.publish(message);
        }
      });
    },
  };
  hooks.set(channelName, hook);
  return hook;
}

module.exports = { getTracingHook };
