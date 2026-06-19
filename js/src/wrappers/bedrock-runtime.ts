import { runWithAutoInstrumentationSuppressed } from "../instrumentation/auto-instrumentation-suppression";
import { bedrockRuntimeChannels } from "../instrumentation/plugins/bedrock-runtime-channels";
import {
  buildBedrockRuntimeSpanInfo,
  getBedrockRuntimeOperation,
} from "../instrumentation/plugins/bedrock-runtime-common";
import type {
  BedrockRuntimeClient,
  BedrockRuntimeCommandLike,
} from "../vendor-sdk-types/bedrock-runtime";

/**
 * Wrap an AWS Bedrock Runtime client with Braintrust tracing.
 */
export function wrapBedrockRuntime<T>(client: T): T {
  if (isSupportedBedrockRuntimeClient(client)) {
    return bedrockRuntimeProxy(client) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving wrapper warning behavior.
  console.warn("Unsupported Bedrock Runtime library. Not wrapping.");
  return client;
}

const bedrockRuntimeProxyCache = new WeakMap<
  BedrockRuntimeClient,
  BedrockRuntimeClient
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSupportedBedrockRuntimeClient(
  value: unknown,
): value is BedrockRuntimeClient {
  return isRecord(value) && typeof value.send === "function";
}

function bedrockRuntimeProxy(
  client: BedrockRuntimeClient,
): BedrockRuntimeClient {
  const cached = bedrockRuntimeProxyCache.get(client);
  if (cached) {
    return cached;
  }

  const privateMethodWorkaroundCache = new WeakMap<
    (...args: unknown[]) => unknown,
    (...args: unknown[]) => unknown
  >();

  const proxy: BedrockRuntimeClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "send") {
        return wrapSend(target.send.bind(target));
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      const cachedValue = privateMethodWorkaroundCache.get(value);
      if (cachedValue) {
        return cachedValue;
      }

      const thisBoundValue = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const thisArg = this === proxy ? target : this;
        const output = Reflect.apply(value, thisArg, args);
        return output === target ? proxy : output;
      };

      privateMethodWorkaroundCache.set(value, thisBoundValue);
      return thisBoundValue;
    },
  });

  bedrockRuntimeProxyCache.set(client, proxy);
  return proxy;
}

function wrapSend(
  send: BedrockRuntimeClient["send"],
): BedrockRuntimeClient["send"] {
  return (command, optionsOrCb, cb) => {
    if (
      getBedrockRuntimeOperation(command) === undefined ||
      typeof optionsOrCb === "function" ||
      typeof cb === "function"
    ) {
      return send(command, optionsOrCb, cb);
    }

    return bedrockRuntimeChannels.clientSend.tracePromise(
      () =>
        runWithAutoInstrumentationSuppressed(() =>
          send(command, optionsOrCb),
        ) as Promise<unknown>,
      {
        arguments: [command as BedrockRuntimeCommandLike, optionsOrCb],
        span_info: buildBedrockRuntimeSpanInfo(command),
      },
    );
  };
}
