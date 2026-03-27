import { anthropicChannels } from "../instrumentation/plugins/anthropic-channels";
import { TypedApplyProxy } from "../typed-instrumentation-helpers";
import type {
  AnthropicBatches,
  AnthropicBeta,
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

  console.warn("Unsupported Anthropic library. Not wrapping.");
  return anthropic;
}

function anthropicProxy(anthropic: AnthropicClient): AnthropicClient {
  return new Proxy(anthropic, {
    get(target, prop, receiver) {
      switch (prop) {
        case "beta":
          return target.beta ? betaProxy(target.beta) : target.beta;
        case "messages":
          return messagesProxy(
            target.messages,
            anthropicChannels.messagesCreate,
          );
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

function betaProxy(beta: AnthropicBeta): AnthropicBeta {
  return new Proxy(beta, {
    get(target, prop, receiver) {
      if (prop === "messages") {
        return messagesProxy(
          target.messages,
          anthropicChannels.betaMessagesCreate,
        );
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function messagesProxy(
  messages: AnthropicMessages,
  channel:
    | typeof anthropicChannels.messagesCreate
    | typeof anthropicChannels.betaMessagesCreate,
): AnthropicMessages {
  return new Proxy(messages, {
    get(target, prop, receiver) {
      // NOTE[matt] We intentionally do not proxy `stream` directly because the
      // SDK implements it in terms of `create(stream=true)`.
      if (prop === "create") {
        return createProxy(target.create, channel);
      }

      if (prop === "batches" && target.batches) {
        return batchesProxy(target.batches);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function batchesProxy(batches: AnthropicBatches): AnthropicBatches {
  return new Proxy(batches, {
    get(target, prop, receiver) {
      switch (prop) {
        case "create":
          return new TypedApplyProxy(target.create, {
            apply(fn, thisArg, args) {
              return anthropicChannels.messagesBatchesCreate.tracePromise(
                () =>
                  Reflect.apply(fn, thisArg, args) as ReturnType<
                    AnthropicBatches["create"]
                  >,
                { arguments: args },
              );
            },
          });
        case "retrieve":
          return new TypedApplyProxy(target.retrieve, {
            apply(fn, thisArg, args) {
              return anthropicChannels.messagesBatchesRetrieve.tracePromise(
                () =>
                  Reflect.apply(fn, thisArg, args) as ReturnType<
                    AnthropicBatches["retrieve"]
                  >,
                { arguments: args },
              );
            },
          });
        case "list":
          return new TypedApplyProxy(target.list, {
            apply(fn, thisArg, args) {
              return anthropicChannels.messagesBatchesList.tracePromise(
                () =>
                  Reflect.apply(fn, thisArg, args) as ReturnType<
                    AnthropicBatches["list"]
                  >,
                { arguments: args },
              );
            },
          });
        case "cancel":
          return new TypedApplyProxy(target.cancel, {
            apply(fn, thisArg, args) {
              return anthropicChannels.messagesBatchesCancel.tracePromise(
                () =>
                  Reflect.apply(fn, thisArg, args) as ReturnType<
                    AnthropicBatches["cancel"]
                  >,
                { arguments: args },
              );
            },
          });
        case "delete":
          return new TypedApplyProxy(target.delete, {
            apply(fn, thisArg, args) {
              return anthropicChannels.messagesBatchesDelete.tracePromise(
                () =>
                  Reflect.apply(fn, thisArg, args) as ReturnType<
                    AnthropicBatches["delete"]
                  >,
                { arguments: args },
              );
            },
          });
        default:
          return Reflect.get(target, prop, receiver);
      }
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
