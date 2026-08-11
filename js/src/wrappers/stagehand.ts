import { stagehandChannels } from "../instrumentation/plugins/stagehand-channels";
import { instrumentStagehandAgent } from "../instrumentation/plugins/stagehand-agent";
import type {
  StagehandActArguments,
  StagehandAgentConfig,
  StagehandConstructor,
  StagehandExtractArguments,
  StagehandInstance,
  StagehandModule,
  StagehandObserveArguments,
} from "../vendor-sdk-types/stagehand";

const WRAPPED_CLASS = Symbol.for("braintrust.stagehand.wrapped-class");
const WRAPPED_INSTANCE = Symbol.for("braintrust.stagehand.wrapped-instance");

/**
 * Wraps the public Stagehand v3 API with Braintrust tracing. The wrapper emits
 * the same channels used by auto-instrumentation, so both paths share one span
 * contract.
 */
export function wrapStagehand<T>(sdk: T): T {
  if (!sdk || typeof sdk !== "object") {
    return sdk;
  }

  const maybeSDK = sdk as Record<PropertyKey, unknown>;
  if (
    typeof maybeSDK.Stagehand !== "function" &&
    typeof maybeSDK.V3 !== "function"
  ) {
    return sdk;
  }

  const target = isModuleNamespace(sdk)
    ? Object.setPrototypeOf({}, sdk)
    : (sdk as Record<PropertyKey, unknown>);
  const wrappedClasses = new WeakMap<
    (...args: unknown[]) => unknown,
    StagehandConstructor
  >();

  return new Proxy(target, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        (prop === "Stagehand" || prop === "V3") &&
        typeof value === "function"
      ) {
        const existing = wrappedClasses.get(value);
        if (existing) {
          return existing;
        }
        const wrapped = wrapStagehandClass(
          value as unknown as StagehandConstructor,
        );
        wrappedClasses.set(value, wrapped);
        return wrapped;
      }
      return value;
    },
  }) as T & StagehandModule;
}

function isModuleNamespace(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  if (obj.constructor?.name === "Module") {
    return true;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(obj, keys[0]);
  return descriptor ? !descriptor.configurable && !descriptor.writable : false;
}

function wrapStagehandClass(
  StagehandClass: StagehandConstructor,
): StagehandConstructor {
  if (
    (StagehandClass as unknown as Record<PropertyKey, unknown>)[WRAPPED_CLASS]
  ) {
    return StagehandClass;
  }

  return new Proxy(StagehandClass, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLASS) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    construct(target, args, newTarget) {
      return wrapStagehandInstance(Reflect.construct(target, args, newTarget));
    },
  });
}

function wrapStagehandInstance(
  stagehand: StagehandInstance,
): StagehandInstance {
  if (!stagehand || typeof stagehand !== "object") {
    return stagehand;
  }
  if (
    (stagehand as unknown as Record<PropertyKey, unknown>)[WRAPPED_INSTANCE]
  ) {
    return stagehand;
  }

  const methodCache = new Map<PropertyKey, unknown>();
  const proxy = new Proxy(stagehand, {
    get(target, prop) {
      if (prop === WRAPPED_INSTANCE) {
        return true;
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }
      const cached = methodCache.get(prop);
      if (cached) {
        return cached;
      }

      let wrapped: unknown;
      if (prop === "act") {
        wrapped = (...args: StagehandActArguments) =>
          stagehandChannels.act.tracePromise(
            () =>
              Reflect.apply(value, target, args) as ReturnType<
                StagehandInstance["act"]
              >,
            { arguments: args, self: target },
          );
      } else if (prop === "extract") {
        wrapped = (...args: StagehandExtractArguments) =>
          stagehandChannels.extract.tracePromise(
            () =>
              Reflect.apply(value, target, args) as ReturnType<
                StagehandInstance["extract"]
              >,
            { arguments: args, self: target },
          );
      } else if (prop === "observe") {
        wrapped = (...args: StagehandObserveArguments) =>
          stagehandChannels.observe.tracePromise(
            () =>
              Reflect.apply(value, target, args) as ReturnType<
                StagehandInstance["observe"]
              >,
            { arguments: args, self: target },
          );
      } else if (prop === "agent") {
        wrapped = (...args: [config?: StagehandAgentConfig]) => {
          const agent = stagehandChannels.agent.traceSync(
            () =>
              Reflect.apply(value, target, args) as ReturnType<
                StagehandInstance["agent"]
              >,
            { arguments: args, self: target },
          );
          return instrumentStagehandAgent(agent, args[0], target);
        };
      } else {
        wrapped = value.bind(target);
      }
      methodCache.set(prop, wrapped);
      return wrapped;
    },
  });

  return proxy;
}
