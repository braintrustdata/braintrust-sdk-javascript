import { debugLogger } from "../debug-logger";
import { instrumentCloudflareAIChatAgent } from "../instrumentation/plugins/cloudflare-ai-chat-instrumentation";
import type {
  CloudflareAIChatAgent,
  CloudflareAIChatAgentConstructor,
  CloudflareAIChatModule,
} from "../vendor-sdk-types/cloudflare-ai-chat";

const wrappedClasses = new WeakMap<object, CloudflareAIChatAgentConstructor>();

/**
 * Wraps the @cloudflare/ai-chat module with Braintrust tracing.
 *
 * Pass the module namespace (`import * as aiChat from "@cloudflare/ai-chat"`)
 * and subclass the wrapped AIChatAgent export. The wrapper emits the same
 * diagnostic-channel events as automatic instrumentation.
 */
export function wrapCloudflareAIChat<T>(module: T): T {
  if (!module || typeof module !== "object") {
    return module;
  }

  const candidate = module as Record<PropertyKey, unknown>;
  let AIChatAgent: unknown;
  try {
    AIChatAgent = Reflect.get(candidate, "AIChatAgent");
  } catch (error) {
    debugLogger.debug("Failed to inspect @cloudflare/ai-chat module:", error);
    return module;
  }

  if (typeof AIChatAgent !== "function") {
    debugLogger.warn(
      "Unsupported @cloudflare/ai-chat module. AIChatAgent was not found; not wrapping.",
    );
    return module;
  }

  const target = isModuleNamespace(module)
    ? Object.setPrototypeOf({}, module)
    : candidate;

  return new Proxy(target, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "AIChatAgent" && typeof value === "function") {
        return wrapAIChatAgentClass(
          value as unknown as CloudflareAIChatAgentConstructor,
        );
      }
      return value;
    },
  }) as T & CloudflareAIChatModule;
}

function wrapAIChatAgentClass(
  AgentClass: CloudflareAIChatAgentConstructor,
): CloudflareAIChatAgentConstructor {
  const cached = wrappedClasses.get(AgentClass);
  if (cached) {
    return cached;
  }

  const wrapped = new Proxy(AgentClass, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    construct(target, args, newTarget) {
      const instance = Reflect.construct(
        target,
        args,
        newTarget,
      ) as CloudflareAIChatAgent;
      return instrumentCloudflareAIChatAgent(instance);
    },
  });
  wrappedClasses.set(AgentClass, wrapped);
  wrappedClasses.set(wrapped, wrapped);
  return wrapped;
}

function isModuleNamespace(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  try {
    if (Reflect.get(value, Symbol.toStringTag) === "Module") {
      return true;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[0]);
    return descriptor
      ? !descriptor.configurable && !descriptor.writable
      : false;
  } catch {
    return false;
  }
}
