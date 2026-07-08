// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

export type Namespace = Record<string | symbol, unknown>;
type ExportSetter = (value: unknown) => boolean;
type ExportGetter = () => unknown;
export type ImportHook = (
  name: string,
  namespace: Namespace,
  specifier?: string,
) => void;

interface RegisterState {
  getters: WeakMap<Namespace, Record<string | symbol, ExportGetter>>;
  hookedModuleCounts: Map<string, number>;
  hookedModules: Set<string>;
  importHooks: ImportHook[];
  setters: WeakMap<Namespace, Record<string | symbol, ExportSetter>>;
  specifiers: Map<string, string | undefined>;
  toHook: Array<[name: string, namespace: Namespace, specifier?: string]>;
}

const stateKey = Symbol.for("braintrust.importInTheMiddle.registerState");
const stateGlobal = globalThis as typeof globalThis &
  Record<symbol, RegisterState | undefined>;

const state: RegisterState = (stateGlobal[stateKey] ??= {
  getters: new WeakMap(),
  hookedModuleCounts: new Map(),
  hookedModules: new Set(),
  importHooks: [], // TODO should this be a Set?
  setters: new WeakMap(),
  specifiers: new Map(),
  toHook: [],
});

const {
  getters,
  hookedModuleCounts,
  hookedModules,
  importHooks,
  setters,
  specifiers,
  toHook,
} = state;

const proxyHandler: ProxyHandler<Namespace> = {
  set(target, name, value) {
    const set = setters.get(target);
    const setter = set && set[name];
    if (typeof setter === "function") {
      return setter(value);
    }
    // If a module doesn't export the property being assigned (e.g. no default
    // export), there is no setter to call. Don't crash userland code.
    return true;
  },

  get(target, name) {
    if (name === Symbol.toStringTag) {
      return "Module";
    }

    const getter = getters.get(target)?.[name];

    if (typeof getter === "function") {
      return getter();
    }
  },

  defineProperty(target, property, descriptor) {
    if (!("value" in descriptor)) {
      throw new Error(
        "Getters/setters are not supported for exports property descriptors.",
      );
    }

    const set = setters.get(target);
    const setter = set && set[property];
    if (typeof setter === "function") {
      return setter(descriptor.value);
    }
    return true;
  },
};

function register(
  name: string,
  namespace: Namespace,
  set: Record<string | symbol, ExportSetter>,
  get: Record<string | symbol, ExportGetter>,
  specifier?: string,
): void {
  specifiers.set(name, specifier);
  setters.set(namespace, set);
  getters.set(namespace, get);
  const proxy = new Proxy(namespace, proxyHandler);
  importHooks.forEach((hook) => hook(name, proxy, specifier));
  toHook.push([name, proxy, specifier]);
}

// Delays (ms) for re-reading exports that were still in their temporal dead zone
// when the wrapper first ran. Retried on a microtask first, then at these
// intervals; unref'd so best-effort retries never hold the process open.
const RETRY_DELAYS = [0, 10, 50];

class ModuleBinder {
  namespace: Namespace = Object.create(null, {
    [Symbol.toStringTag]: { value: "Module" },
  });
  set: Record<string | symbol, ExportSetter> = {};
  get: Record<string | symbol, ExportGetter> = {};
  #overridden: Record<string | symbol, boolean> = Object.create(null);
  #pending: Array<() => boolean> = [];

  bind(
    key: string,
    source: Namespace,
    write: (value: unknown) => void,
    read: () => unknown,
    useFallback: boolean,
  ): void {
    const readSource = useFallback
      ? () => source[key] ?? source.default
      : () => source[key];
    this.#overridden[key] = false;
    let deferred = false;
    try {
      const value = readSource();
      write(value);
      this.namespace[key] = value;
    } catch (error) {
      if (!(error instanceof ReferenceError)) throw error;
      deferred = true;
    }
    if (deferred || read() === undefined) {
      this.#pending.push(this.#makeUpdater(key, readSource, write));
    }
    this.set[key] = (value) => {
      this.#overridden[key] = true;
      write(value);
      return true;
    };
    this.get[key] = read;
  }

  #makeUpdater(
    key: string,
    readSource: () => unknown,
    write: (value: unknown) => void,
  ): () => boolean {
    return () => {
      if (this.#overridden[key] === true) return true;
      try {
        const value = readSource();
        if (value !== undefined) {
          write(value);
          this.namespace[key] = value;
          return true;
        }
        return false;
      } catch (error) {
        if (error instanceof ReferenceError) return false;
        throw error;
      }
    };
  }

  #flushOnce(): void {
    const next = [];
    for (const updater of this.#pending) {
      if (updater() !== true) next.push(updater);
    }
    this.#pending = next;
  }

  flush(): void {
    if (this.#pending.length === 0) return;
    queueMicrotask(() => {
      this.#flushOnce();
      this.#scheduleRetry(0);
    });
  }

  #scheduleRetry(attempt: number): void {
    if (this.#pending.length === 0) return;
    if (attempt >= RETRY_DELAYS.length) {
      this.#pending = [];
      return;
    }
    const timer = setTimeout(() => {
      this.#flushOnce();
      this.#scheduleRetry(attempt + 1);
    }, RETRY_DELAYS[attempt]);
    timer.unref?.();
  }
}

function addHookedModules(modules: readonly string[]): void {
  for (const each of modules) {
    const nextCount = (hookedModuleCounts.get(each) || 0) + 1;
    hookedModuleCounts.set(each, nextCount);
    hookedModules.add(each);
  }
}

function deleteHookedModules(modules: readonly string[]): void {
  for (const each of modules) {
    const nextCount = (hookedModuleCounts.get(each) || 0) - 1;
    if (nextCount > 0) {
      hookedModuleCounts.set(each, nextCount);
    } else {
      hookedModuleCounts.delete(each);
      hookedModules.delete(each);
    }
  }
}

export default {
  addHookedModules,
  deleteHookedModules,
  hookedModules,
  importHooks,
  ModuleBinder,
  register,
  specifiers,
  toHook,
};
