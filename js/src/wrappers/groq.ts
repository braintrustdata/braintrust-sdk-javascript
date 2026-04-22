import { groqChannels } from "../instrumentation/plugins/groq-channels";
import type {
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

function isSupportedGroqClient(value: unknown): value is GroqClient {
  return (
    isRecord(value) &&
    ((value.chat !== undefined && hasChat(value.chat)) ||
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

  const topLevelProxy: GroqClient = new Proxy(groq, {
    get(target, prop, receiver) {
      switch (prop) {
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
      { arguments: [request] },
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
      arguments: [request],
    }) as ReturnType<GroqEmbeddings["create"]>;
}
