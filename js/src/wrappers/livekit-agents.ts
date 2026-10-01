import { debugLogger } from "../debug-logger";
import { liveKitAgentsChannels } from "../instrumentation/plugins/livekit-agents-channels";
import type {
  LiveKitAgentsModule,
  LiveKitTool,
} from "../vendor-sdk-types/livekit-agents";

const wrapped = new WeakMap<object, object>();
const patchedAgents = new WeakSet<object>();

/**
 * Trace LiveKit Agents (1.5+) pipeline nodes and function tools with Braintrust.
 *
 * Call before creating agents or tools. Custom nodes are traced when they
 * delegate to `Agent.default`. Audio is only captured as attachments when
 * `BRAINTRUST_CAPTURE_ATTACHMENTS` is enabled. Use `startLiveKitSessionTrace`,
 * `startLiveKitTurnTrace`, and `captureLiveKitTrace` to trace sessions and turns.
 *
 * @example
 * ```ts
 * import * as livekit from "@livekit/agents";
 * const { voice, llm } = wrapLiveKitAgents(livekit);
 * ```
 */
export function wrapLiveKitAgents<T>(module: T): T {
  const sdk = module as Partial<LiveKitAgentsModule> | null | undefined;
  if (
    typeof sdk?.voice?.Agent !== "function" ||
    typeof sdk.llm?.tool !== "function"
  ) {
    debugLogger.warn("Unsupported LiveKit Agents module. Not wrapping.");
    return module;
  }
  const cached = wrapped.get(sdk);
  if (cached) return cached as T;

  const { voice, llm } = sdk as LiveKitAgentsModule;
  const agent = voice.Agent;
  // Patch the shared methods in place so LiveKit's prototype identity checks
  // and subclasses calling super or Agent.default keep working.
  if (!patchedAgents.has(agent)) {
    patchedAgents.add(agent);
    for (const [method, defaultChannel] of [
      ["sttNode", "defaultSttNode"],
      ["llmNode", "defaultLlmNode"],
      ["ttsNode", "defaultTtsNode"],
    ] as const) {
      const original = agent.prototype[method];
      agent.prototype[method] = function (...args) {
        return liveKitAgentsChannels[method].invoke(original, this, args, {});
      };
      const originalDefault = agent.default[method];
      agent.default[method] = function (...args) {
        return liveKitAgentsChannels[defaultChannel].invoke(
          originalDefault,
          this,
          args,
          {},
        );
      };
    }
  }

  // ESM namespace exports are non-configurable, so a Proxy returning a
  // different `tool` would violate its invariants. Use a facade instead.
  const wrappedLlm = Object.create(llm);
  Object.defineProperty(wrappedLlm, "tool", {
    value: (definition: LiveKitTool) =>
      liveKitAgentsChannels.tool.invoke(llm.tool, llm, [definition], {}),
    enumerable: true,
  });
  const result = Object.create(sdk);
  Object.defineProperty(result, "llm", { value: wrappedLlm, enumerable: true });
  wrapped.set(sdk, result);
  wrapped.set(result, result);
  return result;
}
