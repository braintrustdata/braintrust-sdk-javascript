import { debugLogger } from "../../debug-logger";
import type {
  CloudflareAIChatAgent,
  CloudflareAIChatResponseResult,
} from "../../vendor-sdk-types/cloudflare-ai-chat";
import { cloudflareAIChatChannels } from "./cloudflare-ai-chat-channels";

const wrappedTurnRunners = new WeakSet<object>();
const wrappedResponseHooks = new WeakSet<object>();

export function instrumentCloudflareAIChatAgent(
  agent: CloudflareAIChatAgent,
): CloudflareAIChatAgent {
  try {
    const original = Reflect.get(agent, "_runExclusiveChatTurn");
    if (typeof original !== "function" || wrappedTurnRunners.has(original)) {
      return agent;
    }

    const wrapped = async function (
      this: CloudflareAIChatAgent,
      ...args: Parameters<CloudflareAIChatAgent["_runExclusiveChatTurn"]>
    ): Promise<unknown> {
      return cloudflareAIChatChannels.runExclusiveChatTurn.tracePromise(
        () => Reflect.apply(original, this, args),
        {
          arguments: args,
          self: this,
        },
      );
    };
    wrappedTurnRunners.add(wrapped);

    defineWrappedMethod(agent, "_runExclusiveChatTurn", original, wrapped);
  } catch (error) {
    debugLogger.debug("Failed to wrap @cloudflare/ai-chat turn runner:", error);
  }
  return agent;
}

export function instrumentCloudflareAIChatResponseHook(
  agent: CloudflareAIChatAgent,
): void {
  try {
    const original = Reflect.get(agent, "onChatResponse");
    if (typeof original !== "function" || wrappedResponseHooks.has(original)) {
      return;
    }

    const wrapped = function (
      this: CloudflareAIChatAgent,
      result: CloudflareAIChatResponseResult,
    ): unknown {
      const args: [CloudflareAIChatResponseResult] = [result];
      return cloudflareAIChatChannels.onChatResponse.traceSync(
        () => Reflect.apply(original, this, args),
        {
          arguments: args,
          self: this,
        },
      );
    };
    wrappedResponseHooks.add(wrapped);

    defineWrappedMethod(agent, "onChatResponse", original, wrapped);
  } catch (error) {
    debugLogger.debug(
      "Failed to wrap @cloudflare/ai-chat response hook:",
      error,
    );
  }
}

function defineWrappedMethod(
  target: object,
  property: string,
  original: CallableFunction,
  wrapped: CallableFunction,
): void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, {
    configurable: ownDescriptor?.configurable ?? true,
    enumerable: ownDescriptor?.enumerable ?? false,
    value: wrapped,
    writable:
      ownDescriptor && "writable" in ownDescriptor
        ? ownDescriptor.writable
        : true,
  });

  // Preserve the original function's name where the runtime permits it. This
  // is observability-only and must never make wrapping fail.
  try {
    Object.defineProperty(wrapped, "name", {
      configurable: true,
      value: original.name,
    });
  } catch {
    // Ignore non-configurable function metadata.
  }
}
