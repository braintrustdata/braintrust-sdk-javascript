import { mistralChannels } from "../instrumentation/plugins/mistral-channels";
import type {
  MistralAgents,
  MistralAgentsCompletionResponse,
  MistralAgentsCreateParams,
  MistralAgentsStreamingResult,
  MistralChat,
  MistralChatCompletionResponse,
  MistralChatCreateParams,
  MistralChatStreamingResult,
  MistralClient,
  MistralEmbeddingCreateParams,
  MistralEmbeddingResponse,
  MistralEmbeddings,
  MistralFim,
  MistralFimCompletionResponse,
  MistralFimCreateParams,
  MistralFimStreamingResult,
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
    (value.agents !== undefined && hasAgents(value.agents))
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

function mistralProxy(mistral: MistralClient): MistralClient {
  return new Proxy(mistral, {
    get(target, prop, receiver) {
      switch (prop) {
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

function wrapChatComplete(
  complete: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatCompletionResponse>,
): MistralChat["complete"] {
  return (request, options) =>
    mistralChannels.chatComplete.tracePromise(
      () => complete(request, options),
      {
        arguments: [request],
      } as Parameters<typeof mistralChannels.chatComplete.tracePromise>[1],
    );
}

function wrapChatStream(
  stream: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatStreamingResult>,
): MistralChat["stream"] {
  return (request, options) =>
    mistralChannels.chatStream.tracePromise(() => stream(request, options), {
      arguments: [request],
    } as Parameters<typeof mistralChannels.chatStream.tracePromise>[1]);
}

function wrapEmbeddingsCreate(
  create: (
    request: MistralEmbeddingCreateParams,
    options?: unknown,
  ) => Promise<MistralEmbeddingResponse>,
): MistralEmbeddings["create"] {
  return (request, options) =>
    mistralChannels.embeddingsCreate.tracePromise(
      () => create(request, options),
      { arguments: [request] },
    );
}

function wrapFimComplete(
  complete: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimCompletionResponse>,
): MistralFim["complete"] {
  return (request, options) =>
    mistralChannels.fimComplete.tracePromise(() => complete(request, options), {
      arguments: [request],
    } as Parameters<typeof mistralChannels.fimComplete.tracePromise>[1]);
}

function wrapFimStream(
  stream: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimStreamingResult>,
): MistralFim["stream"] {
  return (request, options) =>
    mistralChannels.fimStream.tracePromise(() => stream(request, options), {
      arguments: [request],
    } as Parameters<typeof mistralChannels.fimStream.tracePromise>[1]);
}

function wrapAgentsComplete(
  complete: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsCompletionResponse>,
): MistralAgents["complete"] {
  return (request, options) =>
    mistralChannels.agentsComplete.tracePromise(
      () => complete(request, options),
      {
        arguments: [request],
      } as Parameters<typeof mistralChannels.agentsComplete.tracePromise>[1],
    );
}

function wrapAgentsStream(
  stream: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsStreamingResult>,
): MistralAgents["stream"] {
  return (request, options) =>
    mistralChannels.agentsStream.tracePromise(() => stream(request, options), {
      arguments: [request],
    } as Parameters<typeof mistralChannels.agentsStream.tracePromise>[1]);
}
