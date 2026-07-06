import { strandsAgentSDKChannels } from "../instrumentation/plugins/strands-agent-sdk-channels";
import type {
  StrandsAgent,
  StrandsAgentConstructor,
  StrandsAgentResult,
  StrandsAgentSDKModule,
  StrandsAgentStreamEvent,
  StrandsInvokeArgs,
  StrandsInvokeOptions,
  StrandsMultiAgent,
  StrandsMultiAgentConstructor,
  StrandsMultiAgentInput,
  StrandsMultiAgentInvokeOptions,
  StrandsMultiAgentResult,
  StrandsMultiAgentStreamEvent,
} from "../vendor-sdk-types/strands-agent-sdk";

const WRAPPED_CLASS = Symbol.for("braintrust.strands-agent-sdk.wrapped-class");
const WRAPPED_INSTANCE = Symbol.for(
  "braintrust.strands-agent-sdk.wrapped-instance",
);

/**
 * Wraps the Strands Agent SDK with Braintrust tracing. The wrapper emits
 * diagnostics-channel events; the Strands plugin owns span lifecycle.
 */
export function wrapStrandsAgentSDK<T>(sdk: T): T {
  if (!sdk || typeof sdk !== "object") {
    return sdk;
  }

  const maybeSDK = sdk as Record<PropertyKey, unknown>;
  if (
    typeof maybeSDK.Agent !== "function" &&
    typeof maybeSDK.Graph !== "function" &&
    typeof maybeSDK.Swarm !== "function"
  ) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Unsupported Strands Agent SDK. Not wrapping.");
    return sdk;
  }

  const target = isModuleNamespace(sdk)
    ? Object.setPrototypeOf({}, sdk)
    : (sdk as Record<PropertyKey, unknown>);

  return new Proxy(target, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "Agent" && typeof value === "function") {
        return wrapAgentClass(value as unknown as StrandsAgentConstructor);
      }
      if (prop === "Graph" && typeof value === "function") {
        return wrapMultiAgentClass(
          value as unknown as StrandsMultiAgentConstructor,
          "graph",
        );
      }
      if (prop === "Swarm" && typeof value === "function") {
        return wrapMultiAgentClass(
          value as unknown as StrandsMultiAgentConstructor,
          "swarm",
        );
      }

      return value;
    },
  }) as T & StrandsAgentSDKModule;
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

function wrapAgentClass(
  AgentClass: StrandsAgentConstructor,
): StrandsAgentConstructor {
  if ((AgentClass as Record<PropertyKey, unknown>)[WRAPPED_CLASS]) {
    return AgentClass;
  }

  return new Proxy(AgentClass, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLASS) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      return wrapAgentInstance(instance as StrandsAgent);
    },
  });
}

function wrapMultiAgentClass(
  MultiAgentClass: StrandsMultiAgentConstructor,
  kind: "graph" | "swarm",
): StrandsMultiAgentConstructor {
  if ((MultiAgentClass as Record<PropertyKey, unknown>)[WRAPPED_CLASS]) {
    return MultiAgentClass;
  }

  return new Proxy(MultiAgentClass, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLASS) {
        return true;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      return wrapMultiAgentInstance(instance as StrandsMultiAgent, kind);
    },
  });
}

function wrapAgentInstance(agent: StrandsAgent): StrandsAgent {
  if (!agent || typeof agent !== "object") {
    return agent;
  }
  if ((agent as Record<PropertyKey, unknown>)[WRAPPED_INSTANCE]) {
    return agent;
  }

  const proxy: StrandsAgent = new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_INSTANCE) {
        return true;
      }

      const value = Reflect.get(target, prop, receiver);
      if (prop === "stream" && typeof value === "function") {
        return function (
          args: StrandsInvokeArgs,
          options?: StrandsInvokeOptions,
        ): AsyncGenerator<
          StrandsAgentStreamEvent,
          StrandsAgentResult,
          undefined
        > {
          const callArgs = [args, options] as [
            StrandsInvokeArgs,
            StrandsInvokeOptions | undefined,
          ];
          return strandsAgentSDKChannels.agentStream.traceSync(
            () => Reflect.apply(value, target, callArgs),
            {
              agent: proxy,
              arguments: callArgs,
              self: proxy,
            } as never,
          );
        };
      }

      if (prop === "invoke" && typeof value === "function") {
        return async function (
          args: StrandsInvokeArgs,
          options?: StrandsInvokeOptions,
        ): Promise<StrandsAgentResult> {
          return consumeAsyncGenerator(proxy.stream(args, options));
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return proxy;
}

function wrapMultiAgentInstance(
  orchestrator: StrandsMultiAgent,
  kind: "graph" | "swarm",
): StrandsMultiAgent {
  if (!orchestrator || typeof orchestrator !== "object") {
    return orchestrator;
  }
  if ((orchestrator as Record<PropertyKey, unknown>)[WRAPPED_INSTANCE]) {
    return orchestrator;
  }

  const proxy: StrandsMultiAgent = new Proxy(orchestrator, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_INSTANCE) {
        return true;
      }

      const value = Reflect.get(target, prop, receiver);
      if (prop === "stream" && typeof value === "function") {
        return function (
          input: StrandsMultiAgentInput,
          options?: StrandsMultiAgentInvokeOptions,
        ): AsyncGenerator<
          StrandsMultiAgentStreamEvent,
          StrandsMultiAgentResult,
          undefined
        > {
          const callArgs = [input, options] as [
            StrandsMultiAgentInput,
            StrandsMultiAgentInvokeOptions | undefined,
          ];
          const channel =
            kind === "graph"
              ? strandsAgentSDKChannels.graphStream
              : strandsAgentSDKChannels.swarmStream;
          return channel.traceSync(
            () => Reflect.apply(value, target, callArgs),
            {
              arguments: callArgs,
              orchestrator: proxy,
              self: proxy,
            } as never,
          );
        };
      }

      if (prop === "invoke" && typeof value === "function") {
        return async function (
          input: StrandsMultiAgentInput,
          options?: StrandsMultiAgentInvokeOptions,
        ): Promise<StrandsMultiAgentResult> {
          return consumeAsyncGenerator(proxy.stream(input, options));
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return proxy;
}

async function consumeAsyncGenerator<TChunk, TReturn>(
  generator: AsyncGenerator<TChunk, TReturn, undefined>,
): Promise<TReturn> {
  let result = await generator.next();
  while (!result.done) {
    result = await generator.next();
  }
  return result.value;
}
