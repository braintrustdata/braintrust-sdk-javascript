import { debugLogger } from "../debug-logger";
import { ollamaChannels } from "../instrumentation/plugins/ollama-channels";
import { isObject } from "../../util";
import type {
  OllamaChatRequest,
  OllamaChatResult,
  OllamaClient,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
  OllamaEmbeddingsRequest,
  OllamaEmbeddingsResponse,
  OllamaGenerateRequest,
  OllamaGenerateResult,
} from "../vendor-sdk-types/ollama";

/**
 * Wrap an Ollama client so generation and embedding calls emit Braintrust
 * diagnostics-channel events.
 */
export function wrapOllama<T>(ollama: T): T {
  if (isSupportedOllamaClient(ollama)) {
    return ollamaProxy(ollama) as T;
  }

  debugLogger.warn("Unsupported Ollama library. Not wrapping.");
  return ollama;
}

const ollamaProxyCache = new WeakMap<OllamaClient, OllamaClient>();

function isSupportedOllamaClient(value: unknown): value is OllamaClient {
  return (
    isObject(value) &&
    ["chat", "generate", "embed", "embeddings"].some(
      (name) => typeof value[name] === "function",
    )
  );
}

function ollamaProxy(ollama: OllamaClient): OllamaClient {
  const cached = ollamaProxyCache.get(ollama);
  if (cached) {
    return cached;
  }

  const proxy = new Proxy(ollama, {
    get(target, prop, receiver) {
      switch (prop) {
        case "chat":
          return typeof target.chat === "function"
            ? wrapChat(target.chat.bind(target))
            : target.chat;
        case "generate":
          return typeof target.generate === "function"
            ? wrapGenerate(target.generate.bind(target))
            : target.generate;
        case "embed":
          return typeof target.embed === "function"
            ? wrapEmbed(target.embed.bind(target))
            : target.embed;
        case "embeddings":
          return typeof target.embeddings === "function"
            ? wrapEmbeddings(target.embeddings.bind(target))
            : target.embeddings;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
  ollamaProxyCache.set(ollama, proxy);
  ollamaProxyCache.set(proxy, proxy);
  return proxy;
}

function wrapChat(
  chat: (request: OllamaChatRequest) => Promise<OllamaChatResult>,
): NonNullable<OllamaClient["chat"]> {
  return (request) =>
    ollamaChannels.chat.tracePromise(() => chat(request), {
      arguments: [request],
    });
}

function wrapGenerate(
  generate: (request: OllamaGenerateRequest) => Promise<OllamaGenerateResult>,
): NonNullable<OllamaClient["generate"]> {
  return (request) =>
    ollamaChannels.generate.tracePromise(() => generate(request), {
      arguments: [request],
    });
}

function wrapEmbed(
  embed: (request: OllamaEmbedRequest) => Promise<OllamaEmbedResponse>,
): NonNullable<OllamaClient["embed"]> {
  return (request) =>
    ollamaChannels.embed.tracePromise(() => embed(request), {
      arguments: [request],
    });
}

function wrapEmbeddings(
  embeddings: (
    request: OllamaEmbeddingsRequest,
  ) => Promise<OllamaEmbeddingsResponse>,
): NonNullable<OllamaClient["embeddings"]> {
  return (request) =>
    ollamaChannels.embeddings.tracePromise(() => embeddings(request), {
      arguments: [request],
    });
}
