/* eslint-disable @typescript-eslint/no-explicit-any */

import { SpanTypeAttribute } from "../../../util";
import { aiSDKChannels } from "../../instrumentation/plugins/ai-sdk-channels";
import type {
  AISDK,
  AISDKAgentClass,
  AISDKAgentInstance,
  AISDKCallParams,
  AISDKEmbedFunction,
  AISDKEmbedParams,
  AISDKGenerateFunction,
  AISDKRerankFunction,
  AISDKRerankParams,
  AISDKStreamFunction,
} from "../../vendor-sdk-types/ai-sdk";

interface WrapAISDKOptions {
  denyOutputPaths?: string[];
}

type SpanInfo = {
  span_info?: {
    metadata?: Record<string, unknown>;
    name?: string;
    spanAttributes?: Record<string, unknown>;
  };
};

type AISDKNamespaceObject = Record<PropertyKey, unknown>;

/**
 * Detects if an object is an ES module namespace (ModuleRecord).
 *
 * ES module namespaces have immutable, non-configurable properties that cause
 * Proxy invariant violations when trying to return wrapped versions of functions.
 *
 * Detection strategy:
 * 1. Check constructor.name === 'Module' (most reliable, suggested by Stephen)
 * 2. Fallback: Check if properties are non-configurable (catches edge cases)
 *
 * @param obj - Object to check
 * @returns true if obj appears to be an ES module namespace
 */
function isModuleNamespace(obj: unknown): obj is AISDKNamespaceObject {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  // Primary detection: Check if constructor is 'Module'
  // ES module namespaces have constructor.name === 'Module'
  if (obj.constructor?.name === "Module") {
    return true;
  }

  // Fallback: Check if properties are non-configurable
  // This catches cases where constructor check might not work
  try {
    const keys = Object.keys(obj);
    if (keys.length === 0) return false;

    const firstKey = keys[0];
    const descriptor = Object.getOwnPropertyDescriptor(obj, firstKey);
    // Module namespace properties are non-configurable and non-writable
    return descriptor
      ? !descriptor.configurable && !descriptor.writable
      : false;
  } catch {
    return false;
  }
}

/**
 * Wraps Vercel AI SDK methods with Braintrust tracing.
 *
 * @param ai - The AI SDK namespace (e.g., import * as ai from "ai")
 * @returns AI SDK with Braintrust tracing.
 *
 * @example
 * ```typescript
 * import { wrapAISDK } from "braintrust";
 * import * as ai from "ai";
 *
 * const { generateText, streamText, generateObject, streamObject, Agent } = wrapAISDK(ai);
 *
 * const result = await generateText({
 *   model: openai("gpt-4"),
 *   prompt: "Hello world"
 * });
 *
 * const agent = new Agent({ model: openai("gpt-4") });
 * const agentResult = await agent.generate({ prompt: "Hello from agent" });
 * ```
 */
export function wrapAISDK<T>(aiSDK: T, options: WrapAISDKOptions = {}): T {
  // Handle null/undefined early - can't create Proxy with non-objects
  if (!aiSDK || typeof aiSDK !== "object") {
    return aiSDK;
  }

  const typedAISDK = aiSDK as unknown as AISDK;

  // Handle ES module namespaces (ModuleRecords) that have non-configurable properties.
  // These cause Proxy invariant violations because we return wrapped functions instead
  // of the original values. Using prototype chain preserves all properties (enumerable
  // and non-enumerable) while avoiding invariants since the target has no own properties.
  // See: https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1259
  const target: AISDKNamespaceObject = isModuleNamespace(aiSDK)
    ? Object.setPrototypeOf({}, aiSDK)
    : (aiSDK as unknown as AISDKNamespaceObject);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return new Proxy(target, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      switch (prop) {
        case "generateText":
          return wrapGenerateText(typedAISDK.generateText, options, typedAISDK);
        case "streamText":
          return wrapStreamText(typedAISDK.streamText, options, typedAISDK);
        case "generateObject":
          return wrapGenerateObject(
            typedAISDK.generateObject,
            options,
            typedAISDK,
          );
        case "streamObject":
          return wrapStreamObject(typedAISDK.streamObject, options, typedAISDK);
        case "embed":
          return wrapEmbed(typedAISDK.embed, options, typedAISDK);
        case "embedMany":
          return wrapEmbedMany(typedAISDK.embedMany, options, typedAISDK);
        case "rerank":
          return typedAISDK.rerank
            ? wrapRerank(typedAISDK.rerank, options, typedAISDK)
            : typedAISDK.rerank;
        case "Agent":
        case "Experimental_Agent":
        case "ToolLoopAgent":
          return original ? wrapAgentClass(original, options) : original;
      }
      return original;
    },
  }) as T;
}

export const wrapAgentClass = (
  AgentClass: any,
  options: WrapAISDKOptions = {},
): any => {
  const typedAgentClass = AgentClass as AISDKAgentClass;

  return new Proxy(typedAgentClass, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(
        target,
        args,
        newTarget,
      ) as AISDKAgentInstance;
      return new Proxy(instance, {
        get(instanceTarget, prop, instanceReceiver) {
          const original = Reflect.get(instanceTarget, prop, instanceTarget);

          if (prop === "generate") {
            return wrapAgentGenerate(original, instanceTarget, options);
          }

          if (prop === "stream") {
            return wrapAgentStream(original, instanceTarget, options);
          }

          // Bind methods to the actual instance to preserve private field access
          if (typeof original === "function") {
            return original.bind(instanceTarget);
          }

          return original;
        },
      });
    },
  }) as any;
};

const wrapAgentGenerate = (
  generate: AISDKGenerateFunction,
  instance: AISDKAgentInstance,
  options: WrapAISDKOptions = {},
) => {
  const defaultName = `${instance.constructor.name}.generate`;
  return async (params: AISDKCallParams & SpanInfo) =>
    makeGenerateTextWrapper(
      aiSDKChannels.generateText,
      defaultName,
      generate.bind(instance),
      {
        self: instance,
        spanType: SpanTypeAttribute.FUNCTION,
      },
      options,
    )({ ...instance.settings, ...params });
};

const wrapAgentStream = (
  stream: AISDKStreamFunction,
  instance: AISDKAgentInstance,
  options: WrapAISDKOptions = {},
) => {
  const defaultName = `${instance.constructor.name}.stream`;
  return (params: AISDKCallParams & SpanInfo) =>
    makeStreamWrapper(
      aiSDKChannels.agentStream,
      defaultName,
      stream.bind(instance),
      {
        self: instance,
        spanType: SpanTypeAttribute.FUNCTION,
      },
      options,
    )({ ...instance.settings, ...params });
};

const makeGenerateTextWrapper = (
  channel:
    | typeof aiSDKChannels.generateText
    | typeof aiSDKChannels.generateObject,
  name: string,
  generateText: AISDKGenerateFunction,
  contextOptions: {
    aiSDK?: AISDK;
    self?: unknown;
    spanType?: SpanTypeAttribute;
  } = {},
  options: WrapAISDKOptions = {},
) => {
  const wrapper = async function (allParams: AISDKCallParams & SpanInfo) {
    const { span_info, ...params } = allParams;
    const tracedParams = { ...params };

    return channel.tracePromise(
      () => generateText(tracedParams),
      createAISDKChannelContext(tracedParams, {
        aiSDK: contextOptions.aiSDK,
        denyOutputPaths: options.denyOutputPaths,
        self: contextOptions.self,
        span_info: mergeSpanInfo(span_info, {
          name,
          spanType: contextOptions.spanType,
        }),
      }),
    );
  };
  Object.defineProperty(wrapper, "name", { value: name, writable: false });
  return wrapper;
};

const wrapGenerateText = (
  generateText: AISDKGenerateFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeGenerateTextWrapper(
    aiSDKChannels.generateText,
    "generateText",
    generateText,
    { aiSDK },
    options,
  );
};

const wrapGenerateObject = (
  generateObject: AISDKGenerateFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeGenerateTextWrapper(
    aiSDKChannels.generateObject,
    "generateObject",
    generateObject,
    { aiSDK },
    options,
  );
};

const makeEmbedWrapper = (
  channel: typeof aiSDKChannels.embed | typeof aiSDKChannels.embedMany,
  name: string,
  embed: AISDKEmbedFunction,
  contextOptions: {
    aiSDK?: AISDK;
    self?: unknown;
    spanType?: SpanTypeAttribute;
  } = {},
  options: WrapAISDKOptions = {},
) => {
  const wrapper = async function (allParams: AISDKEmbedParams & SpanInfo) {
    const { span_info, ...params } = allParams;
    const tracedParams = { ...params };

    return channel.tracePromise(
      () => embed(tracedParams),
      createAISDKChannelContext(tracedParams, {
        aiSDK: contextOptions.aiSDK,
        denyOutputPaths: options.denyOutputPaths,
        self: contextOptions.self,
        span_info: mergeSpanInfo(span_info, {
          name,
          spanType: contextOptions.spanType,
        }),
      }),
    );
  };
  Object.defineProperty(wrapper, "name", { value: name, writable: false });
  return wrapper;
};

const wrapEmbed = (
  embed: AISDKEmbedFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeEmbedWrapper(
    aiSDKChannels.embed,
    "embed",
    embed,
    { aiSDK },
    options,
  );
};

const wrapEmbedMany = (
  embedMany: AISDKEmbedFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeEmbedWrapper(
    aiSDKChannels.embedMany,
    "embedMany",
    embedMany,
    { aiSDK },
    options,
  );
};

const makeRerankWrapper = (
  rerank: AISDKRerankFunction,
  contextOptions: {
    aiSDK?: AISDK;
    self?: unknown;
    spanType?: SpanTypeAttribute;
  } = {},
  options: WrapAISDKOptions = {},
) => {
  const wrapper = async function (allParams: AISDKRerankParams & SpanInfo) {
    const { span_info, ...params } = allParams;
    const tracedParams = { ...params };

    return aiSDKChannels.rerank.tracePromise(
      () => rerank(tracedParams),
      createAISDKChannelContext(tracedParams, {
        aiSDK: contextOptions.aiSDK,
        denyOutputPaths: options.denyOutputPaths,
        self: contextOptions.self,
        span_info: mergeSpanInfo(span_info, {
          name: "rerank",
          spanType: contextOptions.spanType,
        }),
      }),
    );
  };
  Object.defineProperty(wrapper, "name", { value: "rerank", writable: false });
  return wrapper;
};

const wrapRerank = (
  rerank: AISDKRerankFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeRerankWrapper(rerank, { aiSDK }, options);
};

const makeStreamWrapper = (
  channel:
    | typeof aiSDKChannels.streamText
    | typeof aiSDKChannels.streamObject
    | typeof aiSDKChannels.agentStream
    | typeof aiSDKChannels.toolLoopAgentStream,
  name: string,
  streamText: AISDKStreamFunction,
  contextOptions: {
    aiSDK?: AISDK;
    self?: unknown;
    spanType?: SpanTypeAttribute;
  } = {},
  options: WrapAISDKOptions = {},
) => {
  const wrapper = function (allParams: AISDKCallParams & SpanInfo) {
    const { span_info, ...params } = allParams;
    const tracedParams = { ...params };
    const context = createAISDKChannelContext(tracedParams, {
      aiSDK: contextOptions.aiSDK,
      denyOutputPaths: options.denyOutputPaths,
      self: contextOptions.self,
      span_info: mergeSpanInfo(span_info, {
        name,
        spanType: contextOptions.spanType,
      }),
    });

    return channel.tracePromise(() => streamText(tracedParams) as any, context);
  };
  Object.defineProperty(wrapper, "name", { value: name, writable: false });
  return wrapper;
};

const wrapStreamText = (
  streamText: AISDKStreamFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeStreamWrapper(
    aiSDKChannels.streamText,
    "streamText",
    streamText,
    { aiSDK },
    options,
  );
};

const wrapStreamObject = (
  streamObject: AISDKStreamFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeStreamWrapper(
    aiSDKChannels.streamObject,
    "streamObject",
    streamObject,
    { aiSDK },
    options,
  );
};

function mergeSpanInfo(
  spanInfo: SpanInfo["span_info"] | undefined,
  defaults: {
    name?: string;
    spanType?: SpanTypeAttribute;
  },
): SpanInfo["span_info"] | undefined {
  if (
    defaults.name === undefined &&
    defaults.spanType === undefined &&
    spanInfo === undefined
  ) {
    return undefined;
  }

  return {
    ...spanInfo,
    ...(spanInfo?.name ? {} : defaults.name ? { name: defaults.name } : {}),
    ...(defaults.spanType !== undefined || spanInfo?.spanAttributes
      ? {
          spanAttributes: {
            ...(defaults.spanType !== undefined
              ? { type: defaults.spanType }
              : {}),
            ...(spanInfo?.spanAttributes ?? {}),
          },
        }
      : {}),
  };
}

function createAISDKChannelContext<TParams extends Record<string, unknown>>(
  params: TParams,
  context: {
    aiSDK?: AISDK;
    denyOutputPaths?: string[];
    self?: unknown;
    span_info?: SpanInfo["span_info"];
  } = {},
) {
  return {
    arguments: [params] as [TParams],
    ...(context.aiSDK ? { aiSDK: context.aiSDK } : {}),
    ...(context.denyOutputPaths
      ? { denyOutputPaths: context.denyOutputPaths }
      : {}),
    ...(context.self !== undefined ? { self: context.self } : {}),
    ...(context.span_info ? { span_info: context.span_info } : {}),
  };
}
