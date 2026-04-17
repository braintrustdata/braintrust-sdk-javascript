import { anthropicChannels } from "../instrumentation/plugins/anthropic-channels";
import { TypedApplyProxy } from "../typed-instrumentation-helpers";
import type {
  AnthropicBeta,
  AnthropicBetaMessages,
  AnthropicClient,
  AnthropicMessages,
} from "../vendor-sdk-types/anthropic";

/**
 * Wrap an `Anthropic` object (created with `new Anthropic(...)`) so calls emit
 * tracing-channel events that Braintrust plugins can consume.
 *
 * Currently, this only supports the `v4` API.
 *
 * @param anthropic
 * @returns The wrapped `Anthropic` object.
 */
export function wrapAnthropic<T extends object>(anthropic: T): T {
  const au: unknown = anthropic;
  if (
    au &&
    typeof au === "object" &&
    "messages" in au &&
    typeof au.messages === "object" &&
    au.messages &&
    "create" in au.messages
  ) {
    return anthropicProxy(au as AnthropicClient) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported Anthropic library. Not wrapping.");
  return anthropic;
}

function anthropicProxy(anthropic: AnthropicClient): AnthropicClient {
  const proxy: AnthropicClient = new Proxy(anthropic, {
    get(target, prop, receiver) {
      switch (prop) {
        case "beta":
          return target.beta ? betaProxy(target.beta, proxy) : target.beta;
        case "messages":
          return messagesProxy(target.messages);
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });

  return proxy;
}

function betaProxy(
  beta: AnthropicBeta,
  anthropic: AnthropicClient,
): AnthropicBeta {
  return new Proxy(beta, {
    get(target, prop, receiver) {
      if (prop === "messages") {
        return betaMessagesProxy(target.messages, anthropic);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function messagesProxy(messages: AnthropicMessages): AnthropicMessages {
  return new Proxy(messages, {
    get(target, prop, receiver) {
      // NOTE[matt] We intentionally do not proxy `stream` directly because the
      // SDK implements it in terms of `create(stream=true)`.
      if (prop === "create") {
        return createProxy(target.create, anthropicChannels.messagesCreate);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function betaMessagesProxy(
  messages: AnthropicBetaMessages,
  anthropic: AnthropicClient,
): AnthropicBetaMessages {
  return new Proxy(messages, {
    get(target, prop, receiver) {
      // NOTE[matt] We intentionally do not proxy `stream` directly because the
      // SDK implements it in terms of `create(stream=true)`.
      if (prop === "create") {
        return createProxy(target.create, anthropicChannels.betaMessagesCreate);
      }

      if (prop === "toolRunner") {
        if (typeof target.toolRunner !== "function") {
          return Reflect.get(target, prop, receiver);
        }

        return toolRunnerProxy(
          target.toolRunner,
          anthropic,
          anthropicChannels.betaMessagesToolRunner,
        );
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function createProxy(
  create: AnthropicMessages["create"],
  channel:
    | typeof anthropicChannels.messagesCreate
    | typeof anthropicChannels.betaMessagesCreate,
) {
  return new TypedApplyProxy(create, {
    apply(target, thisArg, argArray) {
      return channel.tracePromise(
        () => Reflect.apply(target, thisArg, argArray),
        {
          arguments: argArray,
        },
      );
    },
  });
}

function toolRunnerProxy(
  toolRunner: AnthropicBetaMessages["toolRunner"],
  anthropic: AnthropicClient,
  channel: typeof anthropicChannels.betaMessagesToolRunner,
) {
  return new TypedApplyProxy(toolRunner, {
    apply(target, thisArg, argArray) {
      const invocationTarget =
        thisArg && typeof thisArg === "object"
          ? new Proxy(thisArg, {
              get(currentTarget, prop, receiver) {
                if (prop === "_client") {
                  return anthropic;
                }

                return Reflect.get(currentTarget, prop, receiver);
              },
            })
          : { _client: anthropic };

      return channel.traceSync(
        () => Reflect.apply(target, invocationTarget, argArray),
        {
          arguments: argArray,
        },
      );
    },
  });
}
