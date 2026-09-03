import { runWithAutoInstrumentationSuppressed } from "../instrumentation/auto-instrumentation-suppression";
import { bedrockAgentRuntimeChannels } from "../instrumentation/plugins/bedrock-agent-runtime-channels";
import {
  buildBedrockAgentRuntimeSpanInfo,
  getBedrockAgentRuntimeOperation,
} from "../instrumentation/plugins/bedrock-agent-runtime-common";
import type {
  BedrockAgentRuntimeClient,
  BedrockAgentRuntimeCommandLike,
} from "../vendor-sdk-types/bedrock-agent-runtime";

/**
 * Wrap an AWS Bedrock Agent Runtime client with Braintrust tracing.
 */
export function wrapBedrockAgentRuntime<T>(client: T): T {
  if (isSupportedBedrockAgentRuntimeClient(client)) {
    return bedrockAgentRuntimeProxy(client) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving wrapper warning behavior.
  console.warn("Unsupported Bedrock Agent Runtime library. Not wrapping.");
  return client;
}

const proxyCache = new WeakMap<
  BedrockAgentRuntimeClient,
  BedrockAgentRuntimeClient
>();

const OPERATION_METHODS = new Set([
  "invokeAgent",
  "invokeInlineAgent",
  "retrieveAndGenerate",
  "retrieveAndGenerateStream",
]);

function isSupportedBedrockAgentRuntimeClient(
  value: unknown,
): value is BedrockAgentRuntimeClient {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).send === "function"
  );
}

function bedrockAgentRuntimeProxy(
  client: BedrockAgentRuntimeClient,
): BedrockAgentRuntimeClient {
  const cached = proxyCache.get(client);
  if (cached) {
    return cached;
  }

  const privateMethodCache = new WeakMap<
    (...args: unknown[]) => unknown,
    (...args: unknown[]) => unknown
  >();
  const operationMethodCache = new WeakMap<
    (...args: unknown[]) => unknown,
    (...args: unknown[]) => unknown
  >();

  const proxy: BedrockAgentRuntimeClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "send") {
        return wrapSend(target.send.bind(target));
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (typeof prop === "string" && OPERATION_METHODS.has(prop)) {
        const cachedValue = operationMethodCache.get(value);
        if (cachedValue) {
          return cachedValue;
        }
        const thisBoundValue = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const output = Reflect.apply(
            value,
            this === proxy ? proxy : this,
            args,
          );
          return output === target ? proxy : output;
        };
        operationMethodCache.set(value, thisBoundValue);
        return thisBoundValue;
      }

      const cachedValue = privateMethodCache.get(value);
      if (cachedValue) {
        return cachedValue;
      }
      const thisBoundValue = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const output = Reflect.apply(
          value,
          this === proxy ? target : this,
          args,
        );
        return output === target ? proxy : output;
      };
      privateMethodCache.set(value, thisBoundValue);
      return thisBoundValue;
    },
  });

  proxyCache.set(client, proxy);
  return proxy;
}

function wrapSend(
  send: BedrockAgentRuntimeClient["send"],
): BedrockAgentRuntimeClient["send"] {
  return (command, optionsOrCb, cb) => {
    if (
      getBedrockAgentRuntimeOperation(command) === undefined ||
      typeof optionsOrCb === "function" ||
      typeof cb === "function"
    ) {
      return send(command, optionsOrCb, cb);
    }

    return bedrockAgentRuntimeChannels.clientSend.tracePromise(
      () =>
        runWithAutoInstrumentationSuppressed(() =>
          send(command, optionsOrCb),
        ) as Promise<unknown>,
      {
        arguments: [command as BedrockAgentRuntimeCommandLike, optionsOrCb],
        span_info: buildBedrockAgentRuntimeSpanInfo(command),
      },
    );
  };
}
