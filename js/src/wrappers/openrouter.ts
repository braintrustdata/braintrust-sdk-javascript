import { openRouterChannels } from "../instrumentation/plugins/openrouter-channels";
import type {
  OpenRouterBeta,
  OpenRouterCallModelRequest,
  OpenRouterChat,
  OpenRouterClient,
  OpenRouterEmbeddingCreateParams,
  OpenRouterEmbeddingResponse,
  OpenRouterEmbeddings,
  OpenRouterRerank,
  OpenRouterRerankCreateParams,
  OpenRouterRerankResult,
  OpenRouterResponses,
  OpenRouterResponsesCreateParams,
  OpenRouterResponsesResult,
  OpenRouterChatCreateParams,
  OpenRouterChatResult,
} from "../vendor-sdk-types/openrouter";

/**
 * Wrap an OpenRouter client (created with `new OpenRouter(...)`) so calls emit
 * diagnostics-channel events that Braintrust plugins can consume.
 */
export function wrapOpenRouter<T>(openrouter: T): T {
  const or: unknown = openrouter;
  if (
    or &&
    typeof or === "object" &&
    (("chat" in or &&
      typeof or.chat === "object" &&
      or.chat &&
      "send" in or.chat &&
      "embeddings" in or &&
      typeof or.embeddings === "object" &&
      or.embeddings &&
      "generate" in or.embeddings) ||
      ("rerank" in or &&
        typeof or.rerank === "object" &&
        or.rerank &&
        "rerank" in or.rerank) ||
      ("callModel" in or && typeof or.callModel === "function"))
  ) {
    return openRouterProxy(or as OpenRouterClient) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported OpenRouter library. Not wrapping.");
  return openrouter;
}

function openRouterProxy(openrouter: OpenRouterClient): OpenRouterClient {
  return new Proxy(openrouter, {
    get(target, prop, receiver) {
      switch (prop) {
        case "chat":
          return target.chat ? chatProxy(target.chat) : target.chat;
        case "embeddings":
          return target.embeddings
            ? embeddingsProxy(target.embeddings)
            : target.embeddings;
        case "rerank":
          return target.rerank ? rerankProxy(target.rerank) : target.rerank;
        case "beta":
          return target.beta ? betaProxy(target.beta) : target.beta;
        case "callModel":
          return typeof target.callModel === "function"
            ? wrapCallModel(target.callModel.bind(target))
            : target.callModel;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

function betaProxy(beta: OpenRouterBeta): OpenRouterBeta {
  return new Proxy(beta, {
    get(target, prop, receiver) {
      if (prop === "responses") {
        return target.responses ? responsesProxy(target.responses) : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function chatProxy(chat: OpenRouterChat): OpenRouterChat {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      if (prop === "send") {
        return wrapChatSend(target.send.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function embeddingsProxy(
  embeddings: OpenRouterEmbeddings,
): OpenRouterEmbeddings {
  return new Proxy(embeddings, {
    get(target, prop, receiver) {
      if (prop === "generate") {
        return wrapEmbeddingsGenerate(target.generate.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function responsesProxy(responses: OpenRouterResponses): OpenRouterResponses {
  return new Proxy(responses, {
    get(target, prop, receiver) {
      if (prop === "send") {
        return wrapResponsesSend(target.send.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function rerankProxy(rerank: OpenRouterRerank): OpenRouterRerank {
  return new Proxy(rerank, {
    get(target, prop, receiver) {
      if (prop === "rerank") {
        return wrapRerank(target.rerank.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapChatSend(
  send: (
    request: OpenRouterChatCreateParams,
    options?: unknown,
  ) => Promise<OpenRouterChatResult>,
): OpenRouterChat["send"] {
  return (request, options) =>
    openRouterChannels.chatSend.tracePromise(() => send(request, options), {
      arguments: [request],
    } as Parameters<typeof openRouterChannels.chatSend.tracePromise>[1]);
}

function wrapEmbeddingsGenerate(
  generate: (
    request: OpenRouterEmbeddingCreateParams,
    options?: unknown,
  ) => Promise<OpenRouterEmbeddingResponse>,
): OpenRouterEmbeddings["generate"] {
  return (request, options) =>
    openRouterChannels.embeddingsGenerate.tracePromise(
      () => generate(request, options),
      { arguments: [request] },
    );
}

function wrapResponsesSend(
  send: (
    request: OpenRouterResponsesCreateParams,
    options?: unknown,
  ) => Promise<OpenRouterResponsesResult>,
): OpenRouterResponses["send"] {
  return (request, options) =>
    openRouterChannels.betaResponsesSend.tracePromise(
      () => send(request, options),
      { arguments: [request] },
    );
}

function wrapRerank(
  rerank: (
    request: OpenRouterRerankCreateParams,
    options?: unknown,
  ) => Promise<OpenRouterRerankResult>,
): OpenRouterRerank["rerank"] {
  return (request, options) =>
    openRouterChannels.rerankRerank.tracePromise(
      () => rerank(request, options),
      { arguments: [request] },
    );
}

function wrapCallModel(
  callModel: (
    request: OpenRouterCallModelRequest,
    options?: unknown,
  ) => unknown,
): NonNullable<OpenRouterClient["callModel"]> {
  return (request, options) => {
    const tracedRequest = { ...request };
    return openRouterChannels.callModel.traceSync(
      () => callModel(tracedRequest, options),
      {
        arguments: [tracedRequest],
      } as Parameters<typeof openRouterChannels.callModel.traceSync>[1],
    );
  };
}
