import { registerInstrumentation } from "../instrumentation/registrations/anthropic";
import { debugLogger } from "../debug-logger";
import { anthropicChannels } from "../instrumentation/providers/anthropic-interceptors";
import { TypedApplyProxy } from "../typed-instrumentation-helpers";
import type {
  AnthropicBeta,
  AnthropicBetaMessages,
  AnthropicBetaSessionEvents,
  AnthropicBetaSessions,
  AnthropicBetaSessionThreadEvents,
  AnthropicBetaSessionThreads,
  AnthropicClient,
  AnthropicMessages,
} from "../vendor-sdk-types/anthropic";

/**
 * Wrap an `Anthropic` object (created with `new Anthropic(...)`) so calls emit
 * tracing-channel events that Braintrust plugins can consume.
 *
 * Also supports `AnthropicBedrock` and `AnthropicVertex` clients through their
 * shared Anthropic message resources.
 *
 * Currently, this only supports the `v4` API. Sessions streams are eligible
 * for collection only after being passed to `collectAnthropicSession()`;
 * wrapping and consuming a Sessions stream alone does not emit spans.
 *
 * @param anthropic
 * @returns The wrapped `Anthropic` object.
 */
export function wrapAnthropic<T extends object>(anthropic: T): T {
  registerInstrumentation();
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

  debugLogger.notice.warn("Unsupported Anthropic library. Not wrapping.");
  return anthropic;
}

function anthropicProxy(anthropic: AnthropicClient): AnthropicClient {
  const proxy: AnthropicClient = new Proxy(anthropic, {
    get(target, prop) {
      switch (prop) {
        case "beta":
          return target.beta ? betaProxy(target.beta, proxy) : target.beta;
        case "messages":
          return messagesProxy(target.messages);
        default:
          // Client getters such as openTelemetry access private fields and
          // must run on the original client, including inside toolRunner.
          return Reflect.get(target, prop, target);
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

      if (prop === "sessions") {
        return target.sessions
          ? betaSessionsProxy(target.sessions)
          : target.sessions;
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function betaSessionsProxy(
  sessions: AnthropicBetaSessions,
): AnthropicBetaSessions {
  return new Proxy(sessions, {
    get(target, prop, receiver) {
      if (prop === "events") {
        return betaSessionEventsProxy(target.events);
      }

      if (prop === "threads") {
        return target.threads
          ? betaSessionThreadsProxy(target.threads)
          : target.threads;
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function betaSessionEventsProxy(
  events: AnthropicBetaSessionEvents,
): AnthropicBetaSessionEvents {
  return new Proxy(events, {
    get(target, prop, receiver) {
      if (prop === "stream") {
        return new TypedApplyProxy(target.stream, {
          apply(stream, thisArg, argArray) {
            return anthropicChannels.betaSessionsEventsStream.invoke(
              stream,
              thisArg,
              argArray,
              {},
            );
          },
        });
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function betaSessionThreadsProxy(
  threads: AnthropicBetaSessionThreads,
): AnthropicBetaSessionThreads {
  return new Proxy(threads, {
    get(target, prop, receiver) {
      if (prop === "events") {
        return betaSessionThreadEventsProxy(target.events);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function betaSessionThreadEventsProxy(
  events: AnthropicBetaSessionThreadEvents,
): AnthropicBetaSessionThreadEvents {
  return new Proxy(events, {
    get(target, prop, receiver) {
      if (prop === "stream") {
        return new TypedApplyProxy(target.stream, {
          apply(stream, thisArg, argArray) {
            return anthropicChannels.betaSessionsThreadsEventsStream.invoke(
              stream,
              thisArg,
              argArray,
              {},
            );
          },
        });
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

      // SDK v1 constructs its runner's thread through this helper. Give the
      // thread the wrapped client so its message calls still invoke hooks.
      if (
        prop === "_toolRunnerThread" &&
        typeof target._toolRunnerThread === "function"
      ) {
        return new TypedApplyProxy(target._toolRunnerThread, {
          apply(helper, thisArg, argArray) {
            return Reflect.apply(
              helper,
              withWrappedClient(thisArg, anthropic),
              argArray,
            );
          },
        });
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
      return channel.invoke(target, thisArg, argArray, {});
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
      return channel.invoke(
        target,
        withWrappedClient(thisArg, anthropic),
        argArray,
        {},
      );
    },
  });
}

function withWrappedClient(resource: unknown, anthropic: AnthropicClient) {
  return resource && typeof resource === "object"
    ? new Proxy(resource, {
        get(target, prop, receiver) {
          return prop === "_client"
            ? anthropic
            : Reflect.get(target, prop, receiver);
        },
      })
    : { _client: anthropic };
}
