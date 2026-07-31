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

export function register(
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
  register,
  specifiers,
  toHook,
};
