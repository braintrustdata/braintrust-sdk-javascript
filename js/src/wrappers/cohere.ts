import { cohereChannels } from "../instrumentation/plugins/cohere-channels";
import type {
  CohereChatRequest,
  CohereChatResponse,
  CohereChatStreamResult,
  CohereClient,
  CohereEmbedRequest,
  CohereEmbedResponse,
  CohereRerankRequest,
  CohereRerankResponse,
} from "../vendor-sdk-types/cohere";

/**
 * Wrap a Cohere client so method calls emit diagnostics-channel events that
 * Braintrust plugins can consume.
 */
export function wrapCohere<T>(cohere: T): T {
  if (isSupportedCohereClient(cohere)) {
    return cohereProxy(cohere) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported Cohere library. Not wrapping.");
  return cohere;
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

function isSupportedCohereClient(value: unknown): value is CohereClient {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasFunction(value, "chat") ||
    hasFunction(value, "chatStream") ||
    hasFunction(value, "embed") ||
    hasFunction(value, "rerank")
  );
}

function cohereProxy(cohere: CohereClient): CohereClient {
  return new Proxy(cohere, {
    get(target, prop, receiver) {
      switch (prop) {
        case "chat":
          return typeof target.chat === "function"
            ? wrapChat(target.chat.bind(target))
            : target.chat;
        case "chatStream":
          return typeof target.chatStream === "function"
            ? wrapChatStream(target.chatStream.bind(target))
            : target.chatStream;
        case "embed":
          return typeof target.embed === "function"
            ? wrapEmbed(target.embed.bind(target))
            : target.embed;
        case "rerank":
          return typeof target.rerank === "function"
            ? wrapRerank(target.rerank.bind(target))
            : target.rerank;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

function wrapChat(
  chat: (
    request: CohereChatRequest,
    options?: unknown,
  ) => Promise<CohereChatResponse>,
): NonNullable<CohereClient["chat"]> {
  return (request, options) =>
    cohereChannels.chat.tracePromise(() => chat(request, options), {
      arguments: [request],
    } as Parameters<typeof cohereChannels.chat.tracePromise>[1]);
}

function wrapChatStream(
  chatStream: (
    request: CohereChatRequest,
    options?: unknown,
  ) => Promise<CohereChatStreamResult>,
): NonNullable<CohereClient["chatStream"]> {
  return (request, options) =>
    cohereChannels.chatStream.tracePromise(() => chatStream(request, options), {
      arguments: [request],
    } as Parameters<typeof cohereChannels.chatStream.tracePromise>[1]);
}

function wrapEmbed(
  embed: (
    request: CohereEmbedRequest,
    options?: unknown,
  ) => Promise<CohereEmbedResponse>,
): NonNullable<CohereClient["embed"]> {
  return (request, options) =>
    cohereChannels.embed.tracePromise(() => embed(request, options), {
      arguments: [request],
    });
}

function wrapRerank(
  rerank: (
    request: CohereRerankRequest,
    options?: unknown,
  ) => Promise<CohereRerankResponse>,
): NonNullable<CohereClient["rerank"]> {
  return (request, options) =>
    cohereChannels.rerank.tracePromise(() => rerank(request, options), {
      arguments: [request],
    });
}
