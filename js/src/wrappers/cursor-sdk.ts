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
const boundAgents = new WeakSet<CursorSDKAgent>();

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
            prepareCursorAgent,
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
            prepareCursorAgent,
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
  return proxy;
}

function prepareCursorAgent(agent: unknown): void {
  if (
    !agent ||
    typeof agent !== "object" ||
    typeof Reflect.get(agent, "send") !== "function"
  )
    return;
  const candidate = agent as CursorSDKAgent;
  patchCursorAgentInPlace(candidate);
  if (boundAgents.has(candidate) || !Object.isExtensible(candidate)) return;

  // Keep factory promises and their resolved agent identity intact, while
  // retaining the receiver-safe methods previously provided by the agent proxy.
  for (const key of [
    "close",
    "reload",
    Symbol.asyncDispose,
    "listArtifacts",
    "downloadArtifact",
  ] as const) {
    const method = candidate[key];
    if (typeof method !== "function") continue;
    const own = Object.getOwnPropertyDescriptor(candidate, key);
    if (own && !own.configurable && !own.writable) continue;
    Object.defineProperty(candidate, key, {
      configurable: own?.configurable ?? true,
      enumerable: own?.enumerable ?? false,
      writable: own?.writable ?? true,
      value: method.bind(candidate),
    });
  }
  boundAgents.add(candidate);
}
