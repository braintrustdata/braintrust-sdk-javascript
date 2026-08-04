import { debugLogger } from "../debug-logger";
import { ollamaChannels } from "../instrumentation/plugins/ollama-channels";
import { isObject } from "../../util";
import type {
  OllamaChatRequest,
  OllamaChatResult,
  OllamaClient,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
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
    ["chat", "generate", "embed"].some(
      (name) => typeof value[name] === "function",
    )
  );
}

function ollamaProxy(ollama: OllamaClient): OllamaClient {
  const cached = ollamaProxyCache.get(ollama);
  if (cached) {
    return cached;
  }

  let chatSource: OllamaClient["chat"];
  let wrappedChat: OllamaClient["chat"];
  let generateSource: OllamaClient["generate"];
  let wrappedGenerate: OllamaClient["generate"];
  let embedSource: OllamaClient["embed"];
  let wrappedEmbed: OllamaClient["embed"];

  const proxy = new Proxy(ollama, {
    get(target, prop, receiver) {
      switch (prop) {
        case "chat": {
          const source = target.chat;
          if (source !== chatSource) {
            chatSource = source;
            wrappedChat =
              typeof source === "function"
                ? wrapChat(source.bind(target))
                : source;
          }
          return wrappedChat;
        }
        case "generate": {
          const source = target.generate;
          if (source !== generateSource) {
            generateSource = source;
            wrappedGenerate =
              typeof source === "function"
                ? wrapGenerate(source.bind(target))
                : source;
          }
          return wrappedGenerate;
        }
        case "embed": {
          const source = target.embed;
          if (source !== embedSource) {
            embedSource = source;
            wrappedEmbed =
              typeof source === "function"
                ? wrapEmbed(source.bind(target))
                : source;
          }
          return wrappedEmbed;
        }
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
