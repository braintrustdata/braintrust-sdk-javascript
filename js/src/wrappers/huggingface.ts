import { huggingFaceChannels } from "../instrumentation/plugins/huggingface-channels";
import type {
  HuggingFaceChatCompletion,
  HuggingFaceChatCompletionChunk,
  HuggingFaceChatCompletionParams,
  HuggingFaceClient,
  HuggingFaceClientConstructor,
  HuggingFaceFeatureExtractionOutput,
  HuggingFaceFeatureExtractionParams,
  HuggingFaceModule,
  HuggingFaceRequestOptions,
  HuggingFaceTextGenerationOutput,
  HuggingFaceTextGenerationParams,
  HuggingFaceTextGenerationStreamOutput,
} from "../vendor-sdk-types/huggingface";

const HUGGINGFACE_CONSTRUCTOR_KEYS = [
  "InferenceClient",
  "InferenceClientEndpoint",
  "HfInference",
  "HfInferenceEndpoint",
] as const;
const HUGGINGFACE_CONSTRUCTOR_KEY_SET: ReadonlySet<string> = new Set(
  HUGGINGFACE_CONSTRUCTOR_KEYS,
);

/**
 * Wrap a HuggingFace Inference SDK module or client with Braintrust tracing.
 *
 * Supports the LLM and embeddings APIs we intentionally instrument:
 * - chatCompletion
 * - chatCompletionStream
 * - textGeneration
 * - textGenerationStream
 * - featureExtraction
 */
export function wrapHuggingFace(
  huggingFace: HuggingFaceModule,
): HuggingFaceModule;
export function wrapHuggingFace(
  huggingFace: HuggingFaceClient,
): HuggingFaceClient;
export function wrapHuggingFace<T>(huggingFace: T): T;
export function wrapHuggingFace(huggingFace: unknown): unknown {
  if (isSupportedHuggingFaceModule(huggingFace)) {
    return moduleProxy(huggingFace);
  }

  if (isSupportedHuggingFaceClient(huggingFace)) {
    return clientProxy(huggingFace);
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported HuggingFace Inference SDK. Not wrapping.");
  return huggingFace;
}

function isHuggingFaceConstructorKey(
  value: string,
): value is (typeof HUGGINGFACE_CONSTRUCTOR_KEYS)[number] {
  return HUGGINGFACE_CONSTRUCTOR_KEY_SET.has(value);
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

function isSupportedHuggingFaceModule(
  value: unknown,
): value is HuggingFaceModule {
  if (!isRecord(value)) {
    return false;
  }

  return (
    HUGGINGFACE_CONSTRUCTOR_KEYS.some(
      (key) => key in value && typeof value[key] === "function",
    ) || isSupportedHuggingFaceClient(value)
  );
}

function isSupportedHuggingFaceClient(
  value: unknown,
): value is HuggingFaceClient {
  return (
    hasFunction(value, "chatCompletion") &&
    hasFunction(value, "chatCompletionStream") &&
    hasFunction(value, "textGeneration") &&
    hasFunction(value, "textGenerationStream") &&
    hasFunction(value, "featureExtraction")
  );
}

function moduleProxy(module: HuggingFaceModule): HuggingFaceModule {
  const shadowTarget = Object.create(module);
  return new Proxy(shadowTarget, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && isHuggingFaceConstructorKey(prop)) {
        const value = Reflect.get(module, prop, receiver);
        return typeof value === "function"
          ? wrapClientConstructor(value)
          : value;
      }

      switch (prop) {
        case "chatCompletion":
          return target.chatCompletion
            ? wrapChatCompletion(target.chatCompletion.bind(target))
            : target.chatCompletion;
        case "chatCompletionStream":
          return target.chatCompletionStream
            ? wrapChatCompletionStream(target.chatCompletionStream.bind(target))
            : target.chatCompletionStream;
        case "textGeneration":
          return target.textGeneration
            ? wrapTextGeneration(target.textGeneration.bind(target))
            : target.textGeneration;
        case "textGenerationStream":
          return target.textGenerationStream
            ? wrapTextGenerationStream(target.textGenerationStream.bind(target))
            : target.textGenerationStream;
        case "featureExtraction":
          return target.featureExtraction
            ? wrapFeatureExtraction(target.featureExtraction.bind(target))
            : target.featureExtraction;
        default:
          return Reflect.get(module, prop, receiver);
      }
    },
  });
}

function wrapClientConstructor(
  constructor: HuggingFaceClientConstructor,
): HuggingFaceClientConstructor {
  return new Proxy(constructor, {
    construct(target, args) {
      const instance: HuggingFaceClient = Reflect.construct(target, args);
      return clientProxy(instance);
    },
  });
}

function clientProxy(client: HuggingFaceClient): HuggingFaceClient {
  return clientProxyWithContext(client);
}

function clientProxyWithContext(
  client: HuggingFaceClient,
  endpointUrl?: string,
): HuggingFaceClient {
  const shadowTarget = Object.create(client);
  return new Proxy(shadowTarget, {
    get(_target, prop, receiver) {
      switch (prop) {
        case "chatCompletion":
          return wrapChatCompletion(
            client.chatCompletion.bind(client),
            endpointUrl,
          );
        case "chatCompletionStream":
          return wrapChatCompletionStream(
            client.chatCompletionStream.bind(client),
            endpointUrl,
          );
        case "textGeneration":
          return wrapTextGeneration(
            client.textGeneration.bind(client),
            endpointUrl,
          );
        case "textGenerationStream":
          return wrapTextGenerationStream(
            client.textGenerationStream.bind(client),
            endpointUrl,
          );
        case "featureExtraction":
          return wrapFeatureExtraction(
            client.featureExtraction.bind(client),
            endpointUrl,
          );
        case "endpoint":
          if (!client.endpoint) {
            return client.endpoint;
          }
          {
            const endpoint = client.endpoint.bind(client);
            return (nextEndpointUrl: string) =>
              clientProxyWithContext(
                endpoint(nextEndpointUrl),
                nextEndpointUrl,
              );
          }
        default:
          return Reflect.get(client, prop, receiver);
      }
    },
  });
}

function withEndpointUrl<T extends Record<string, unknown>>(
  params: T,
  endpointUrl?: string,
): T {
  if (!endpointUrl || params.endpointUrl !== undefined) {
    return params;
  }

  return {
    ...params,
    endpointUrl,
  };
}

function wrapChatCompletion(
  original: (
    params: HuggingFaceChatCompletionParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceChatCompletion>,
  endpointUrl?: string,
): HuggingFaceClient["chatCompletion"] {
  return (params, options) => {
    const traceParams = withEndpointUrl(params, endpointUrl);
    const context: Parameters<
      typeof huggingFaceChannels.chatCompletion.tracePromise
    >[1] = {
      arguments: [traceParams],
    };
    return huggingFaceChannels.chatCompletion.tracePromise(
      () => original(params, options),
      context,
    );
  };
}

function wrapChatCompletionStream(
  original: (
    params: HuggingFaceChatCompletionParams,
    options?: HuggingFaceRequestOptions,
  ) => AsyncIterable<HuggingFaceChatCompletionChunk>,
  endpointUrl?: string,
): HuggingFaceClient["chatCompletionStream"] {
  return (params, options) =>
    huggingFaceChannels.chatCompletionStream.traceSync(
      () => original(params, options),
      {
        arguments: [withEndpointUrl(params, endpointUrl)],
      },
    );
}

function wrapTextGeneration(
  original: (
    params: HuggingFaceTextGenerationParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceTextGenerationOutput>,
  endpointUrl?: string,
): HuggingFaceClient["textGeneration"] {
  return (params, options) => {
    const traceParams = withEndpointUrl(params, endpointUrl);
    const context: Parameters<
      typeof huggingFaceChannels.textGeneration.tracePromise
    >[1] = {
      arguments: [traceParams],
    };
    return huggingFaceChannels.textGeneration.tracePromise(
      () => original(params, options),
      context,
    );
  };
}

function wrapTextGenerationStream(
  original: (
    params: HuggingFaceTextGenerationParams,
    options?: HuggingFaceRequestOptions,
  ) => AsyncIterable<HuggingFaceTextGenerationStreamOutput>,
  endpointUrl?: string,
): HuggingFaceClient["textGenerationStream"] {
  return (params, options) =>
    huggingFaceChannels.textGenerationStream.traceSync(
      () => original(params, options),
      {
        arguments: [withEndpointUrl(params, endpointUrl)],
      },
    );
}

function wrapFeatureExtraction(
  original: (
    params: HuggingFaceFeatureExtractionParams,
    options?: HuggingFaceRequestOptions,
  ) => Promise<HuggingFaceFeatureExtractionOutput>,
  endpointUrl?: string,
): HuggingFaceClient["featureExtraction"] {
  return (params, options) => {
    const traceParams = withEndpointUrl(params, endpointUrl);
    const context: Parameters<
      typeof huggingFaceChannels.featureExtraction.tracePromise
    >[1] = {
      arguments: [traceParams],
    };
    return huggingFaceChannels.featureExtraction.tracePromise(
      () => original(params, options),
      context,
    );
  };
}
