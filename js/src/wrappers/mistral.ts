import { mistralChannels } from "../instrumentation/plugins/mistral-channels";
import type {
  MistralAgents,
  MistralChat,
  MistralClassifiers,
  MistralClient,
  MistralEmbeddings,
  MistralFim,
} from "../vendor-sdk-types/mistral";

/**
 * Wrap a Mistral client (created with `new Mistral(...)`) with Braintrust tracing.
 */
export function wrapMistral<T>(mistral: T): T {
  if (isSupportedMistralClient(mistral)) {
    return mistralProxy(mistral) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported Mistral library. Not wrapping.");
  return mistral;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(value: unknown, methodName: string): boolean {
  return (
    isRecord(value) &&
    methodName in value &&
    typeof value[methodName] === "function"
  );
}

function isSupportedMistralClient(value: unknown): value is MistralClient {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.chat !== undefined && hasChat(value.chat)) ||
    (value.embeddings !== undefined && hasEmbeddings(value.embeddings)) ||
    (value.fim !== undefined && hasFim(value.fim)) ||
    (value.agents !== undefined && hasAgents(value.agents)) ||
    (value.classifiers !== undefined && hasClassifiers(value.classifiers))
  );
}

function hasChat(value: unknown): value is MistralChat {
  return hasFunction(value, "complete") && hasFunction(value, "stream");
}

function hasEmbeddings(value: unknown): value is MistralEmbeddings {
  return hasFunction(value, "create");
}

function hasFim(value: unknown): value is MistralFim {
  return hasFunction(value, "complete") && hasFunction(value, "stream");
}

function hasAgents(value: unknown): value is MistralAgents {
  return hasFunction(value, "complete") && hasFunction(value, "stream");
}

function hasClassifiers(value: unknown): value is MistralClassifiers {
  return hasFunction(value, "moderate") && hasFunction(value, "moderateChat");
}

type MistralMethodChannel = {
  invoke(
    target: (request: unknown, options?: unknown) => PromiseLike<unknown>,
    thisArg: unknown,
    args: [unknown, unknown?],
    additional: Record<string, never>,
  ): PromiseLike<unknown>;
};

type MistralMethodChannels = Map<string | symbol, MistralMethodChannel>;

const MISTRAL_RESOURCE_CHANNELS = new Map<
  string | symbol,
  MistralMethodChannels
>([
  [
    "chat",
    new Map([
      ["complete", mistralChannels.chatComplete],
      ["stream", mistralChannels.chatStream],
    ]),
  ],
  ["embeddings", new Map([["create", mistralChannels.embeddingsCreate]])],
  [
    "fim",
    new Map([
      ["complete", mistralChannels.fimComplete],
      ["stream", mistralChannels.fimStream],
    ]),
  ],
  [
    "agents",
    new Map([
      ["complete", mistralChannels.agentsComplete],
      ["stream", mistralChannels.agentsStream],
    ]),
  ],
  [
    "classifiers",
    new Map([
      ["moderate", mistralChannels.classifiersModerate],
      ["moderateChat", mistralChannels.classifiersModerateChat],
      ["classify", mistralChannels.classifiersClassify],
      ["classifyChat", mistralChannels.classifiersClassifyChat],
    ]),
  ],
]);

// Only newer SDK versions have these, so they are wrapped only when present.
const OPTIONAL_MISTRAL_METHODS = new Set<string | symbol>([
  "classify",
  "classifyChat",
]);

// The property reads below intentionally match the original per-resource
// proxies, so SDK getters run the same number of times with the same receiver.
function mistralProxy(mistral: MistralClient): MistralClient {
  return new Proxy(mistral, {
    get(target, prop, receiver) {
      const channels = MISTRAL_RESOURCE_CHANNELS.get(prop);
      if (!channels) {
        return Reflect.get(target, prop, receiver);
      }

      if (!Reflect.get(target, prop)) {
        return Reflect.get(target, prop);
      }

      return resourceProxy(Reflect.get(target, prop), channels);
    },
  });
}

function resourceProxy(
  resource: object,
  channels: MistralMethodChannels,
): object {
  return new Proxy(resource, {
    get(target, prop, receiver) {
      const channel = channels.get(prop);
      if (
        !channel ||
        (OPTIONAL_MISTRAL_METHODS.has(prop) && !Reflect.get(target, prop))
      ) {
        return Reflect.get(target, prop, receiver);
      }

      // Binding on access throws for non-function values, as before.
      const method = Reflect.get(target, prop).bind(target);
      return (request: unknown, options?: unknown) =>
        channel.invoke(method, target, [request, options], {});
    },
  });
}
