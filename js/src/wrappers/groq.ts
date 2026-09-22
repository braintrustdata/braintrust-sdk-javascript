import { groqChannels } from "../instrumentation/plugins/groq-channels";
import type {
  GroqAudio,
  GroqAudioSpeech,
  GroqAudioTranscriptions,
  GroqAudioTranslations,
  GroqChat,
  GroqChatCompletion,
  GroqChatCreateParams,
  GroqChatStream,
  GroqClient,
  GroqEmbeddingCreateParams,
  GroqEmbeddingResponse,
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

  const completionProxy = groq.chat?.completions
    ? new Proxy(groq.chat.completions, {
        get(target, prop, receiver) {
          if (prop === "create") {
            return wrapChatCompletionsCreate(target.create.bind(target));
          }

          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

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

  const embeddingsProxy = groq.embeddings
    ? new Proxy(groq.embeddings, {
        get(target, prop, receiver) {
          if (prop === "create") {
            return wrapEmbeddingsCreate(target.create.bind(target));
          }

          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

  const speechProxy = groq.audio?.speech
    ? new Proxy(groq.audio.speech, {
        get(target, prop, receiver) {
          if (prop === "create") {
            return wrapAudioSpeechCreate(target.create.bind(target));
          }

          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

  const transcriptionsProxy = groq.audio?.transcriptions
    ? new Proxy(groq.audio.transcriptions, {
        get(target, prop, receiver) {
          if (prop === "create") {
            return wrapAudioTranscriptionsCreate(target.create.bind(target));
          }

          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

  const translationsProxy = groq.audio?.translations
    ? new Proxy(groq.audio.translations, {
        get(target, prop, receiver) {
          if (prop === "create") {
            return wrapAudioTranslationsCreate(target.create.bind(target));
          }

          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

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

function wrapChatCompletionsCreate(
  create: (
    request: GroqChatCreateParams,
    options?: unknown,
  ) => Promise<GroqChatCompletion | GroqChatStream>,
): GroqChat["completions"]["create"] {
  return (request, options) =>
    groqChannels.chatCompletionsCreate.tracePromise(
      () => create(request, options),
      { arguments: [request, options] },
    ) as ReturnType<GroqChat["completions"]["create"]>;
}

function wrapEmbeddingsCreate(
  create: (
    request: GroqEmbeddingCreateParams,
    options?: unknown,
  ) => Promise<GroqEmbeddingResponse>,
): GroqEmbeddings["create"] {
  return (request, options) =>
    groqChannels.embeddingsCreate.tracePromise(() => create(request, options), {
      arguments: [request, options],
    }) as ReturnType<GroqEmbeddings["create"]>;
}

function wrapAudioSpeechCreate(
  create: GroqAudioSpeech["create"],
): GroqAudioSpeech["create"] {
  return (request, options) =>
    groqChannels.audioSpeechCreate.tracePromise(
      () => create(request, options),
      { arguments: [request, options] },
    ) as ReturnType<GroqAudioSpeech["create"]>;
}

function wrapAudioTranscriptionsCreate(
  create: GroqAudioTranscriptions["create"],
): GroqAudioTranscriptions["create"] {
  return (request, options) =>
    groqChannels.audioTranscriptionsCreate.tracePromise(
      () => create(request, options),
      { arguments: [request, options] },
    ) as ReturnType<GroqAudioTranscriptions["create"]>;
}

function wrapAudioTranslationsCreate(
  create: GroqAudioTranslations["create"],
): GroqAudioTranslations["create"] {
  return (request, options) =>
    groqChannels.audioTranslationsCreate.tracePromise(
      () => create(request, options),
      { arguments: [request, options] },
    ) as ReturnType<GroqAudioTranslations["create"]>;
}
