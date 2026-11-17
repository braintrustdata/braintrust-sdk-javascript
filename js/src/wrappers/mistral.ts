import { registerInstrumentation } from "../instrumentation/registrations/mistral";
import { debugLogger } from "../debug-logger";
import { mistralChannels } from "../instrumentation/providers/mistral-interceptors";
import type {
  MistralAudio,
  MistralOCR,
  MistralAgents,
  MistralAgentsCompletionResponse,
  MistralAgentsCreateParams,
  MistralAgentsStreamingResult,
  MistralChat,
  MistralChatClassificationCreateParams,
  MistralChatCompletionResponse,
  MistralChatCreateParams,
  MistralChatStreamingResult,
  MistralClassificationCreateParams,
  MistralClassificationResponse,
  MistralClassifiers,
  MistralClient,
  MistralEmbeddingCreateParams,
  MistralEmbeddingResponse,
  MistralEmbeddings,
  MistralFim,
  MistralFimCompletionResponse,
  MistralFimCreateParams,
  MistralFimStreamingResult,
  MistralModerationResponse,
} from "../vendor-sdk-types/mistral";

/**
 * Wrap a Mistral client (created with `new Mistral(...)`) with Braintrust tracing.
 */
export function wrapMistral<T>(mistral: T): T {
  registerInstrumentation();
  if (isSupportedMistralClient(mistral)) {
    return mistralProxy(mistral) as T;
  }

  debugLogger.notice.warn("Unsupported Mistral library. Not wrapping.");
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
    (value.classifiers !== undefined && hasClassifiers(value.classifiers)) ||
    hasFunction(value.ocr, "process") ||
    (isRecord(value.audio) &&
      (hasFunction(value.audio.transcriptions, "complete") ||
        hasFunction(value.audio.speech, "complete")))
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

function mistralProxy(mistral: MistralClient): MistralClient {
  return new Proxy(mistral, {
    get(target, prop, receiver) {
      switch (prop) {
        case "ocr":
          return target.ocr ? ocrProxy(target.ocr) : target.ocr;
        case "audio":
          return target.audio ? audioProxy(target.audio) : target.audio;
        case "chat":
          return target.chat ? chatProxy(target.chat) : target.chat;
        case "fim":
          return target.fim ? fimProxy(target.fim) : target.fim;
        case "agents":
          return target.agents ? agentsProxy(target.agents) : target.agents;
        case "embeddings":
          return target.embeddings
            ? embeddingsProxy(target.embeddings)
            : target.embeddings;
        case "classifiers":
          return target.classifiers
            ? classifiersProxy(target.classifiers)
            : target.classifiers;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

function chatProxy(chat: MistralChat): MistralChat {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      if (prop === "complete") {
        return wrapChatComplete(target.complete.bind(target));
      }

      if (prop === "stream") {
        return wrapChatStream(target.stream.bind(target));
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function embeddingsProxy(embeddings: MistralEmbeddings): MistralEmbeddings {
  return new Proxy(embeddings, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return wrapEmbeddingsCreate(target.create.bind(target));
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function fimProxy(fim: MistralFim): MistralFim {
  return new Proxy(fim, {
    get(target, prop, receiver) {
      if (prop === "complete") {
        return wrapFimComplete(target.complete.bind(target));
      }

      if (prop === "stream") {
        return wrapFimStream(target.stream.bind(target));
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function agentsProxy(agents: MistralAgents): MistralAgents {
  return new Proxy(agents, {
    get(target, prop, receiver) {
      if (prop === "complete") {
        return wrapAgentsComplete(target.complete.bind(target));
      }

      if (prop === "stream") {
        return wrapAgentsStream(target.stream.bind(target));
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function classifiersProxy(classifiers: MistralClassifiers): MistralClassifiers {
  return new Proxy(classifiers, {
    get(target, prop, receiver) {
      if (prop === "moderate") {
        return wrapClassifiersModerate(target.moderate.bind(target));
      }

      if (prop === "moderateChat") {
        return wrapClassifiersModerateChat(target.moderateChat.bind(target));
      }

      if (prop === "classify" && target.classify) {
        return wrapClassifiersClassify(target.classify.bind(target));
      }

      if (prop === "classifyChat" && target.classifyChat) {
        return wrapClassifiersClassifyChat(target.classifyChat.bind(target));
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapChatComplete(
  complete: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatCompletionResponse>,
): MistralChat["complete"] {
  return (request, options) =>
    mistralChannels.chatComplete.invoke(
      complete,
      undefined,
      [request, options],
      {},
    );
}

function wrapChatStream(
  stream: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatStreamingResult>,
): MistralChat["stream"] {
  return (request, options) =>
    mistralChannels.chatStream.invoke(
      stream,
      undefined,
      [request, options],
      {},
    );
}

function wrapEmbeddingsCreate(
  create: (
    request: MistralEmbeddingCreateParams,
    options?: unknown,
  ) => Promise<MistralEmbeddingResponse>,
): MistralEmbeddings["create"] {
  return (request, options) =>
    mistralChannels.embeddingsCreate.invoke(
      create,
      undefined,
      [request, options],
      {},
    );
}

function wrapClassifiersModerate(
  moderate: (
    request: MistralClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralModerationResponse>,
): MistralClassifiers["moderate"] {
  return (request, options) =>
    mistralChannels.classifiersModerate.invoke(
      moderate,
      undefined,
      [request, options],
      {},
    );
}

function wrapClassifiersModerateChat(
  moderateChat: (
    request: MistralChatClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralModerationResponse>,
): MistralClassifiers["moderateChat"] {
  return (request, options) =>
    mistralChannels.classifiersModerateChat.invoke(
      moderateChat,
      undefined,
      [request, options],
      {},
    );
}

function wrapClassifiersClassify(
  classify: (
    request: MistralClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralClassificationResponse>,
): NonNullable<MistralClassifiers["classify"]> {
  return (request, options) =>
    mistralChannels.classifiersClassify.invoke(
      classify,
      undefined,
      [request, options],
      {},
    );
}

function wrapClassifiersClassifyChat(
  classifyChat: (
    request: MistralChatClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralClassificationResponse>,
): NonNullable<MistralClassifiers["classifyChat"]> {
  return (request, options) =>
    mistralChannels.classifiersClassifyChat.invoke(
      classifyChat,
      undefined,
      [request, options],
      {},
    );
}

function wrapFimComplete(
  complete: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimCompletionResponse>,
): MistralFim["complete"] {
  return (request, options) =>
    mistralChannels.fimComplete.invoke(
      complete,
      undefined,
      [request, options],
      {},
    );
}

function wrapFimStream(
  stream: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimStreamingResult>,
): MistralFim["stream"] {
  return (request, options) =>
    mistralChannels.fimStream.invoke(stream, undefined, [request, options], {});
}

function wrapAgentsComplete(
  complete: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsCompletionResponse>,
): MistralAgents["complete"] {
  return (request, options) =>
    mistralChannels.agentsComplete.invoke(
      complete,
      undefined,
      [request, options],
      {},
    );
}

function wrapAgentsStream(
  stream: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsStreamingResult>,
): MistralAgents["stream"] {
  return (request, options) =>
    mistralChannels.agentsStream.invoke(
      stream,
      undefined,
      [request, options],
      {},
    );
}

function ocrProxy(ocr: MistralOCR): MistralOCR {
  return new Proxy(ocr, {
    get(target, prop, receiver) {
      if (prop === "process" && typeof target.process === "function") {
        return (...args: Parameters<MistralOCR["process"]>) =>
          mistralChannels.ocrProcess.invoke(target.process, target, args, {});
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function audioProxy(audio: MistralAudio): MistralAudio {
  return new Proxy(audio, {
    get(target, prop, receiver) {
      if (prop === "speech" && target.speech) {
        return new Proxy(target.speech, {
          get(speech, method, receiver) {
            if (
              method === "complete" &&
              typeof speech.complete === "function"
            ) {
              return (...args: Parameters<typeof speech.complete>) =>
                mistralChannels.speechComplete.invoke(
                  speech.complete,
                  speech,
                  args,
                  {},
                );
            }
            return Reflect.get(speech, method, receiver);
          },
        });
      }
      if (prop === "transcriptions" && target.transcriptions) {
        return new Proxy(target.transcriptions, {
          get(transcriptions, method, receiver) {
            if (
              method === "complete" &&
              typeof transcriptions.complete === "function"
            ) {
              return (...args: Parameters<typeof transcriptions.complete>) =>
                mistralChannels.transcriptionsComplete.invoke(
                  transcriptions.complete,
                  transcriptions,
                  args,
                  {},
                );
            }
            if (
              method === "stream" &&
              typeof transcriptions.stream === "function"
            ) {
              return (...args: Parameters<typeof transcriptions.stream>) =>
                mistralChannels.transcriptionsStream.invoke(
                  transcriptions.stream,
                  transcriptions,
                  args,
                  {},
                );
            }
            return Reflect.get(transcriptions, method, receiver);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
