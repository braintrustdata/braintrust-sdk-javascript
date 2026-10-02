import { markInvocationContext } from "../global-instrumentation-hooks";
import { openRouterAgentChannels } from "../instrumentation/plugins/openrouter-agent-channels";
import type {
  OpenRouterAgentClient,
  OpenRouterAgentCallModelRequest,
} from "../vendor-sdk-types/openrouter-agent";

/**
 * Wrap an @openrouter/agent OpenRouter client so callModel() passes through
 * the Braintrust instrumentation hooks consumed by the OpenRouter Agent plugin.
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

      // Existing consumers observe callModel() through traceSync(). Like
      // generated auto-instrumentation, keep that lifecycle around the
      // intercepted call and mark its context as interceptor-owned.
      return openRouterAgentChannels.callModel.traceSync(
        () =>
          openRouterAgentChannels.callModel.invoke(
            target,
            invocationTarget,
            [request, options],
            {},
          ),
        markInvocationContext({ arguments: [request] }),
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
