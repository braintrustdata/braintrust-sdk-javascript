import { groqChannels } from "../instrumentation/plugins/groq-channels";
import type {
  GroqAudio,
  GroqChat,
  GroqClient,
  GroqEmbeddings,
} from "../vendor-sdk-types/groq";

/**
 * Wrap a Groq client (created with `new Groq(...)`) with Braintrust tracing.
 */
export function wrapGroq<T extends object>(groq: T): T {
  if (isSupportedGroqClient(groq)) {
    return groqProxy(groq) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported Groq library. Not wrapping.");
  return groq;
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

function hasChat(value: unknown): value is GroqChat {
  return (
    isRecord(value) &&
    isRecord(value.completions) &&
    hasFunction(value.completions, "create")
  );
}

function hasEmbeddings(value: unknown): value is GroqEmbeddings {
  return hasFunction(value, "create");
}

function hasAudio(value: unknown): value is GroqAudio {
  return (
    isRecord(value) &&
    ((value.speech !== undefined && hasFunction(value.speech, "create")) ||
      (value.transcriptions !== undefined &&
        hasFunction(value.transcriptions, "create")) ||
      (value.translations !== undefined &&
        hasFunction(value.translations, "create")))
  );
}

function isSupportedGroqClient(value: unknown): value is GroqClient {
  return (
    isRecord(value) &&
    ((value.audio !== undefined && hasAudio(value.audio)) ||
      (value.chat !== undefined && hasChat(value.chat)) ||
      (value.embeddings !== undefined && hasEmbeddings(value.embeddings)))
  );
}

function groqProxy(groq: GroqClient): GroqClient {
  const privateMethodWorkaroundCache = new WeakMap<
    (...args: unknown[]) => unknown,
    (...args: unknown[]) => unknown
  >();

  const completionProxy = proxyCreateMethod(
    groq.chat?.completions,
    groqChannels.chatCompletionsCreate,
  );

  const chatProxy = groq.chat
    ? new Proxy(groq.chat, {
        get(target, prop, receiver) {
          if (prop === "completions") {
            return completionProxy ?? target.completions;
          }

          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

  const embeddingsProxy = proxyCreateMethod(
    groq.embeddings,
    groqChannels.embeddingsCreate,
  );

  const speechProxy = proxyCreateMethod(
    groq.audio?.speech,
    groqChannels.audioSpeechCreate,
  );

  const transcriptionsProxy = proxyCreateMethod(
    groq.audio?.transcriptions,
    groqChannels.audioTranscriptionsCreate,
  );

  const translationsProxy = proxyCreateMethod(
    groq.audio?.translations,
    groqChannels.audioTranslationsCreate,
  );

  const audioProxy = groq.audio
    ? new Proxy(groq.audio, {
        get(target, prop, receiver) {
          switch (prop) {
            case "speech":
              return speechProxy ?? target.speech;
            case "transcriptions":
              return transcriptionsProxy ?? target.transcriptions;
            case "translations":
              return translationsProxy ?? target.translations;
            default:
              return Reflect.get(target, prop, receiver);
          }
        },
      })
    : undefined;

  const topLevelProxy: GroqClient = new Proxy(groq, {
    get(target, prop, receiver) {
      switch (prop) {
        case "audio":
          return audioProxy ?? target.audio;
        case "chat":
          return chatProxy ?? target.chat;
        case "embeddings":
          return embeddingsProxy ?? target.embeddings;
      }

      const value = Reflect.get(target, prop, target);
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
        const thisArg = this === topLevelProxy ? target : this;
        const output = Reflect.apply(value, thisArg, args);
        return output === target ? topLevelProxy : output;
      };

      privateMethodWorkaroundCache.set(value, thisBoundValue);
      return thisBoundValue;
    },
  });

  return topLevelProxy;
}

function proxyCreateMethod<TParams, TResult extends PromiseLike<unknown>>(
  resource:
    | { create: (params: TParams, options?: unknown) => TResult }
    | undefined,
  channel: {
    invoke(
      target: (params: TParams, options?: unknown) => TResult,
      thisArg: unknown,
      args: [TParams, unknown?],
      additional: Record<string, never>,
    ): TResult;
  },
) {
  return resource
    ? new Proxy(resource, {
        get(target, prop, receiver) {
          if (prop === "create") {
            // Bind on access, so clients without `create` still fail on read.
            const create = target.create.bind(target);
            return (request: TParams, options?: unknown) =>
              channel.invoke(create, target, [request, options], {});
          }

          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;
}
