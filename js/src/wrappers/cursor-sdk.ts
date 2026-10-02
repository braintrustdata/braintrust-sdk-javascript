import { cursorSDKChannels } from "../instrumentation/plugins/cursor-sdk-channels";
import type {
  CursorSDKAgent,
  CursorSDKAgentClass,
  CursorSDKAgentOptions,
  CursorSDKRunResult,
  CursorSDKSendOptions,
  CursorSDKUserMessage,
} from "../vendor-sdk-types/cursor-sdk";

const WRAPPED_AGENT = Symbol.for("braintrust.cursor-sdk.wrapped-agent");

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
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported Cursor SDK. Not wrapping.");
    return sdk;
  }

  const target = isModuleNamespace(sdk)
    ? Object.setPrototypeOf({}, sdk)
    : (sdk as Record<PropertyKey, unknown>);

  return new Proxy(target, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
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
  const cache = new Map<PropertyKey, unknown>();

  return new Proxy(Agent, {
    get(target, prop, receiver) {
      if (cache.has(prop)) {
        return cache.get(prop);
      }

      const value = Reflect.get(target, prop, receiver);
      if (prop === "create" && typeof value === "function") {
        const wrapped = async function (
          options: CursorSDKAgentOptions,
        ): Promise<CursorSDKAgent> {
          const args = [options] as [CursorSDKAgentOptions];
          return wrapCursorAgent(
            await cursorSDKChannels.create.invoke(value, target, args, {}),
          );
        };
        cache.set(prop, wrapped);
        return wrapped;
      }

      if (prop === "resume" && typeof value === "function") {
        const wrapped = async function (
          agentId: string,
          options?: Partial<CursorSDKAgentOptions>,
        ): Promise<CursorSDKAgent> {
          const args = [agentId, options] as [
            string,
            Partial<CursorSDKAgentOptions> | undefined,
          ];
          return wrapCursorAgent(
            await cursorSDKChannels.resume.invoke(value, target, args, {}),
          );
        };
        cache.set(prop, wrapped);
        return wrapped;
      }

      if (prop === "prompt" && typeof value === "function") {
        const wrapped = async function (
          message: string | CursorSDKUserMessage,
          options?: CursorSDKAgentOptions,
        ): Promise<CursorSDKRunResult> {
          const args = [message, options] as [
            string | CursorSDKUserMessage,
            CursorSDKAgentOptions | undefined,
          ];
          return cursorSDKChannels.prompt.invoke(value, target, args, {});
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
}

function wrapCursorAgent(agent: CursorSDKAgent): CursorSDKAgent {
  if (!agent || typeof agent !== "object") {
    return agent;
  }
  if ((agent as Record<PropertyKey, unknown>)[WRAPPED_AGENT]) {
    return agent;
  }

  const proxy = new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_AGENT) {
        return true;
      }

      const value = Reflect.get(target, prop, receiver);
      if (
        prop === "send" &&
        typeof value === "function" &&
        !(target as Record<PropertyKey, unknown>)[
          Symbol.for("braintrust.cursor-sdk.auto-patched-agent")
        ]
      ) {
        return function (
          message: string | CursorSDKUserMessage,
          options?: CursorSDKSendOptions,
        ) {
          const args = [message, options] as [
            string | CursorSDKUserMessage,
            CursorSDKSendOptions | undefined,
          ];
          return cursorSDKChannels.send.invoke(
            value as CursorSDKAgent["send"],
            target,
            args,
            { agent: target, operation: "send" },
          );
        };
      }

      if (typeof value === "function") {
        return value.bind(target);
      }

      return value;
    },
  });

  return proxy as CursorSDKAgent;
}
