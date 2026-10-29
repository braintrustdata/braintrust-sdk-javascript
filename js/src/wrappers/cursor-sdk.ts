import { debugLogger } from "../debug-logger";
import { observeResult } from "../instrumentation/core/observe-result";
import {
  cursorSDKChannels,
  patchCursorAgentInPlace,
} from "../instrumentation/plugins/cursor-sdk-interceptors";
import type {
  CursorSDKAgent,
  CursorSDKAgentClass,
  CursorSDKRunResult,
} from "../vendor-sdk-types/cursor-sdk";

const wrappedClasses = new WeakMap<CursorSDKAgentClass, CursorSDKAgentClass>();

/**
 * Wraps the Cursor TypeScript SDK with Braintrust tracing. The wrapper emits
 * invocation hooks; the Cursor SDK plugin owns span lifecycle.
 */
export function wrapCursorSDK<T>(sdk: T): T {
  if (!sdk || typeof sdk !== "object") {
    return sdk;
  }

  const maybeSDK = sdk as Record<PropertyKey, unknown>;
  if (!maybeSDK.Agent || typeof maybeSDK.Agent !== "function") {
    debugLogger.notice.warn("Unsupported Cursor SDK. Not wrapping.");
    return sdk;
  }

  const target = isModuleNamespace(sdk)
    ? Object.setPrototypeOf({}, sdk)
    : (sdk as Record<PropertyKey, unknown>);

  return new Proxy(target, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "Agent" && typeof value === "function") {
        return wrapCursorAgentClass(value as unknown as CursorSDKAgentClass);
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as T;
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

function wrapCursorAgentClass(Agent: CursorSDKAgentClass): CursorSDKAgentClass {
  const existing = wrappedClasses.get(Agent);
  if (existing) return existing;
  const cache = new Map<PropertyKey, unknown>();

  const proxy = new Proxy(Agent, {
    get(target, prop) {
      if (cache.has(prop)) {
        return cache.get(prop);
      }

      const value = Reflect.get(target, prop, target);
      if (prop === "create" && typeof value === "function") {
        const wrapped = function (
          ...args: Parameters<CursorSDKAgentClass["create"]>
        ): Promise<CursorSDKAgent> {
          return observeResult(
            cursorSDKChannels.create.invoke(value, target, args, {}),
            patchCursorAgentInPlace,
            () => {},
          ) as Promise<CursorSDKAgent>;
        };
        cache.set(prop, wrapped);
        return wrapped;
      }

      if (prop === "resume" && typeof value === "function") {
        const wrapped = function (
          ...args: Parameters<CursorSDKAgentClass["resume"]>
        ): Promise<CursorSDKAgent> {
          return observeResult(
            cursorSDKChannels.resume.invoke(value, target, args, {}),
            patchCursorAgentInPlace,
            () => {},
          ) as Promise<CursorSDKAgent>;
        };
        cache.set(prop, wrapped);
        return wrapped;
      }

      if (prop === "prompt" && typeof value === "function") {
        const wrapped = function (
          ...args: Parameters<CursorSDKAgentClass["prompt"]>
        ): Promise<CursorSDKRunResult> {
          return cursorSDKChannels.prompt.invoke(
            value,
            target,
            args,
            {},
          ) as Promise<CursorSDKRunResult>;
        };
        cache.set(prop, wrapped);
        return wrapped;
      }

      if (typeof value === "function") {
        const bound = value.bind(target);
        cache.set(prop, bound);
        return bound;
      }

      return value;
    },
  }) as CursorSDKAgentClass;
  wrappedClasses.set(Agent, proxy);
  wrappedClasses.set(proxy, proxy);
  // Agent.prompt calls factories on the original class internally. Install the
  // same generic factory wrappers so explicitly wrapped prompts can observe
  // their returned agents even without the automatic loader.
  for (const name of ["create", "resume"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(Agent, name);
    if (descriptor?.configurable && typeof descriptor.value === "function") {
      Object.defineProperty(Agent, name, {
        ...descriptor,
        value: Reflect.get(proxy, name),
      });
    }
  }
  return proxy;
}
