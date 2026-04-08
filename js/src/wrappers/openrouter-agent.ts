import { openRouterAgentChannels } from "../instrumentation/plugins/openrouter-agent-channels";
import type {
  OpenRouterAgentClient,
  OpenRouterAgentCallModelRequest,
} from "../vendor-sdk-types/openrouter-agent";

/**
 * Wrap an @openrouter/agent OpenRouter client so callModel() emits
 * diagnostics-channel events consumed by the OpenRouter Agent plugin.
 */
export function wrapOpenRouterAgent<T extends object>(agent: T): T {
  const candidate: unknown = agent;
  if (
    candidate &&
    typeof candidate === "object" &&
    "callModel" in candidate &&
    typeof candidate.callModel === "function"
  ) {
    return openRouterAgentProxy(candidate as OpenRouterAgentClient) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported OpenRouter Agent library. Not wrapping.");
  return agent;
}

function openRouterAgentProxy(
  agent: OpenRouterAgentClient,
): OpenRouterAgentClient {
  const cache = new Map<PropertyKey, unknown>();

  return new Proxy(agent, {
    get(target, prop, receiver) {
      if (cache.has(prop)) {
        return cache.get(prop);
      }

      const value = Reflect.get(target, prop, receiver);

      if (prop === "callModel" && typeof value === "function") {
        const wrapped = wrapCallModel(
          value as NonNullable<OpenRouterAgentClient["callModel"]>,
          target,
        );
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
  });
}

function wrapCallModel(
  callModelFn: NonNullable<OpenRouterAgentClient["callModel"]>,
  defaultThis?: unknown,
): NonNullable<OpenRouterAgentClient["callModel"]> {
  return new Proxy(callModelFn, {
    apply(target, thisArg, argArray) {
      const request = cloneCallModelRequest(argArray[0]);
      const options = argArray[1] as Parameters<
        NonNullable<OpenRouterAgentClient["callModel"]>
      >[1];
      const invocationTarget =
        thisArg === undefined ? (defaultThis ?? thisArg) : thisArg;

      return openRouterAgentChannels.callModel.traceSync(
        () => Reflect.apply(target, invocationTarget, [request, options]),
        {
          arguments: [request],
        } as Parameters<typeof openRouterAgentChannels.callModel.traceSync>[1],
      );
    },
  });
}

function cloneCallModelRequest(
  request: unknown,
): OpenRouterAgentCallModelRequest {
  if (!request || typeof request !== "object") {
    return request as OpenRouterAgentCallModelRequest;
  }

  return { ...(request as OpenRouterAgentCallModelRequest) };
}
