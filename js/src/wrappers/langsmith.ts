import { debugLogger } from "../debug-logger";
import { langSmithChannels } from "../instrumentation/plugins/langsmith-channels";
import type {
  LangSmithClient,
  LangSmithClientConstructor,
  LangSmithRunTree,
  LangSmithRunTreeConstructor,
  LangSmithTraceable,
  LangSmithTraceableConfig,
} from "../vendor-sdk-types/langsmith";

const WRAPPED_CLIENT_CLASS = Symbol.for(
  "braintrust.langsmith.wrapped-client-class",
);
const WRAPPED_CLIENT_INSTANCE = Symbol.for(
  "braintrust.langsmith.wrapped-client-instance",
);
const WRAPPED_CLIENT_NAMESPACE = Symbol.for(
  "braintrust.langsmith.wrapped-client-namespace",
);
const WRAPPED_RUN_TREE_CLASS = Symbol.for(
  "braintrust.langsmith.wrapped-run-tree-class",
);
const WRAPPED_RUN_TREE_INSTANCE = Symbol.for(
  "braintrust.langsmith.wrapped-run-tree-instance",
);
const WRAPPED_RUN_TREES_NAMESPACE = Symbol.for(
  "braintrust.langsmith.wrapped-run-trees-namespace",
);
const WRAPPED_TRACEABLE = Symbol.for("braintrust.langsmith.wrapped-traceable");
const WRAPPED_TRACEABLE_NAMESPACE = Symbol.for(
  "braintrust.langsmith.wrapped-traceable-namespace",
);

export function wrapLangSmithTraceable<T>(namespace: T): T {
  return wrapNamespaceExport(
    namespace,
    "traceable",
    WRAPPED_TRACEABLE_NAMESPACE,
    (value) => wrapTraceable(value as LangSmithTraceable),
  );
}

export function wrapLangSmithRunTrees<T>(namespace: T): T {
  return wrapNamespaceExport(
    namespace,
    "RunTree",
    WRAPPED_RUN_TREES_NAMESPACE,
    (value) => wrapRunTreeClass(value as LangSmithRunTreeConstructor),
  );
}

export function wrapLangSmithClient<T>(namespace: T): T {
  return wrapNamespaceExport(
    namespace,
    "Client",
    WRAPPED_CLIENT_NAMESPACE,
    (value) => wrapClientClass(value as LangSmithClientConstructor),
  );
}

function wrapNamespaceExport<T>(
  namespace: T,
  exportName: string,
  marker: symbol,
  wrap: (value: unknown) => unknown,
): T {
  if (!namespace || typeof namespace !== "object") {
    return namespace;
  }

  const candidate = namespace as Record<PropertyKey, unknown>;
  if (candidate[marker] === true) {
    return namespace;
  }
  if (typeof candidate[exportName] !== "function") {
    // eslint-disable-next-line no-restricted-properties -- public wrapper diagnostics follow existing wrapper behavior.
    console.warn(
      `Unsupported LangSmith ${exportName} namespace. Not wrapping.`,
    );
    return namespace;
  }

  const target = isModuleNamespace(namespace)
    ? Object.setPrototypeOf({}, namespace)
    : candidate;
  const moduleNamespace = target !== candidate;
  let wrappedExport: unknown;

  return new Proxy(target, {
    get(target, prop, receiver) {
      if (prop === marker) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      if (prop !== exportName || typeof value !== "function") {
        return value;
      }
      wrappedExport ??= wrap(value);
      return wrappedExport;
    },
    getOwnPropertyDescriptor(target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor || !moduleNamespace) {
        return descriptor;
      }
      const namespaceDescriptor = Reflect.getOwnPropertyDescriptor(
        candidate,
        prop,
      );
      return namespaceDescriptor
        ? { ...namespaceDescriptor, configurable: true }
        : undefined;
    },
    has(target, prop) {
      return (
        Reflect.has(target, prop) || (moduleNamespace && prop in candidate)
      );
    },
    ownKeys(target) {
      return moduleNamespace
        ? Reflect.ownKeys(candidate)
        : Reflect.ownKeys(target);
    },
  }) as T;
}

function isModuleNamespace(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value.constructor?.name === "Module") {
    return true;
  }
  const firstKey = Object.keys(value)[0];
  if (!firstKey) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, firstKey);
  return descriptor ? !descriptor.configurable && !descriptor.writable : false;
}

function wrapTraceable(traceable: LangSmithTraceable): LangSmithTraceable {
  if (
    (traceable as unknown as Record<PropertyKey, unknown>)[WRAPPED_TRACEABLE]
  ) {
    return traceable;
  }

  return new Proxy(traceable, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_TRACEABLE) {
        return true;
      }
      return Reflect.get(target, prop, receiver);
    },
    apply(target, thisArg, argArray) {
      const [fn, rawConfig] = argArray;
      const config =
        rawConfig && typeof rawConfig === "object"
          ? (rawConfig as LangSmithTraceableConfig)
          : undefined;
      const originalOnEnd = config?.on_end;
      const wrappedConfig: LangSmithTraceableConfig = {
        ...config,
        on_end(runTree) {
          publishRunUpdate(runTree);
          if (originalOnEnd) {
            Reflect.apply(originalOnEnd, config, [runTree]);
          }
        },
      };
      return Reflect.apply(target, thisArg, [fn, wrappedConfig]);
    },
  });
}

function wrapRunTreeClass(
  RunTree: LangSmithRunTreeConstructor,
): LangSmithRunTreeConstructor {
  if (
    (RunTree as unknown as Record<PropertyKey, unknown>)[WRAPPED_RUN_TREE_CLASS]
  ) {
    return RunTree;
  }

  return new Proxy(RunTree, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_RUN_TREE_CLASS) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    construct(target, args, newTarget) {
      return wrapRunTreeInstance(Reflect.construct(target, args, newTarget));
    },
  });
}

function wrapRunTreeInstance(runTree: LangSmithRunTree): LangSmithRunTree {
  if ((runTree as Record<PropertyKey, unknown>)[WRAPPED_RUN_TREE_INSTANCE]) {
    return runTree;
  }

  return new Proxy(runTree, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_RUN_TREE_INSTANCE) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      let wrapped: unknown;
      if (prop === "createChild") {
        wrapped = (...args: unknown[]) =>
          wrapRunTreeInstance(Reflect.apply(value, target, args));
      } else if (prop === "postRun") {
        const method = value as (...args: unknown[]) => Promise<unknown>;
        wrapped = (...args: unknown[]) =>
          langSmithChannels.createRun.tracePromise(
            () => Reflect.apply(method, target, args),
            { arguments: [target] },
          );
      } else if (prop === "patchRun") {
        const method = value as (...args: unknown[]) => Promise<unknown>;
        wrapped = (...args: unknown[]) =>
          langSmithChannels.updateRun.tracePromise(
            () => Reflect.apply(method, target, args),
            {
              arguments: [
                typeof target.id === "string" ? target.id : "",
                target,
              ],
            },
          );
      } else {
        wrapped = value.bind(target);
      }
      return wrapped;
    },
  });
}

function wrapClientClass(
  Client: LangSmithClientConstructor,
): LangSmithClientConstructor {
  if (
    (Client as unknown as Record<PropertyKey, unknown>)[WRAPPED_CLIENT_CLASS]
  ) {
    return Client;
  }

  return new Proxy(Client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLIENT_CLASS) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    construct(target, args, newTarget) {
      return wrapClientInstance(Reflect.construct(target, args, newTarget));
    },
  });
}

function wrapClientInstance(client: LangSmithClient): LangSmithClient {
  if ((client as Record<PropertyKey, unknown>)[WRAPPED_CLIENT_INSTANCE]) {
    return client;
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLIENT_INSTANCE) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      let wrapped: unknown;
      if (prop === "createRun") {
        const method = value as (...args: unknown[]) => Promise<unknown>;
        wrapped = (
          ...args: Parameters<NonNullable<LangSmithClient["createRun"]>>
        ) =>
          langSmithChannels.createRun.tracePromise(
            () => Reflect.apply(method, target, args),
            { arguments: args },
          );
      } else if (prop === "updateRun") {
        const method = value as (...args: unknown[]) => Promise<unknown>;
        wrapped = (
          ...args: Parameters<NonNullable<LangSmithClient["updateRun"]>>
        ) =>
          langSmithChannels.updateRun.tracePromise(
            () => Reflect.apply(method, target, args),
            { arguments: args },
          );
      } else if (prop === "batchIngestRuns") {
        const method = value as (...args: unknown[]) => Promise<unknown>;
        wrapped = (
          ...args: Parameters<NonNullable<LangSmithClient["batchIngestRuns"]>>
        ) =>
          langSmithChannels.batchIngestRuns.tracePromise(
            () => Reflect.apply(method, target, args),
            { arguments: args },
          );
      } else {
        wrapped = value.bind(target);
      }
      return wrapped;
    },
  });
}

function publishRunUpdate(runTree: LangSmithRunTree | undefined): void {
  if (!runTree || typeof runTree.id !== "string" || !runTree.id) {
    return;
  }

  try {
    void langSmithChannels.updateRun
      .tracePromise(() => Promise.resolve(undefined), {
        arguments: [runTree.id, runTree],
      })
      .catch((error) => {
        debugLogger.error("LangSmith traceable instrumentation failed:", error);
      });
  } catch (error) {
    debugLogger.error("LangSmith traceable instrumentation failed:", error);
  }
}
