import { debugLogger } from "../debug-logger";
import { cloudflareAgentsChannels } from "../instrumentation/plugins/cloudflare-agents-channels";
import type { CloudflareAgent } from "../vendor-sdk-types/cloudflare-agents";

const WRAPPED_RUN_AGENT_TOOL = Symbol.for(
  "braintrust.cloudflare-agents.wrapped-run-agent-tool",
);

/**
 * Adds Braintrust tracing to a Cloudflare Agents base `Agent` class.
 *
 * The returned value is the same class, patched in place so existing Durable
 * Object exports and inheritance continue to work unchanged.
 */
export function wrapCloudflareAgent<T>(Agent: T): T {
  if (typeof Agent !== "function") {
    warnUnsupportedAgent();
    return Agent;
  }

  const prototypeDescriptor = Object.getOwnPropertyDescriptor(
    Agent,
    "prototype",
  );
  const prototype =
    prototypeDescriptor && "value" in prototypeDescriptor
      ? prototypeDescriptor.value
      : undefined;
  if (!isObjectLike(prototype)) {
    warnUnsupportedAgent();
    return Agent;
  }

  if (ownValue(prototype, WRAPPED_RUN_AGENT_TOOL) === true) {
    return Agent;
  }

  const descriptor = Object.getOwnPropertyDescriptor(prototype, "runAgentTool");
  if (!descriptor || typeof descriptor.value !== "function") {
    warnUnsupportedAgent();
    return Agent;
  }

  const originalRunAgentTool: CloudflareAgent["runAgentTool"] =
    descriptor.value;
  Object.defineProperty(prototype, "runAgentTool", {
    ...descriptor,
    value: function wrappedRunAgentTool(
      this: CloudflareAgent,
      ...args: Parameters<CloudflareAgent["runAgentTool"]>
    ) {
      const options = args[1];
      if (ownValue(options, "detached")) {
        return Reflect.apply(originalRunAgentTool, this, args);
      }

      return cloudflareAgentsChannels.runAgentTool.tracePromise(
        () => Reflect.apply(originalRunAgentTool, this, args),
        { arguments: args, self: this },
      );
    },
  });
  Object.defineProperty(prototype, WRAPPED_RUN_AGENT_TOOL, {
    configurable: false,
    enumerable: false,
    value: true,
  });

  return Agent;
}

function ownValue(value: unknown, key: PropertyKey): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function warnUnsupportedAgent(): void {
  debugLogger.warn("Unsupported Cloudflare Agents Agent class. Not wrapping.");
}
