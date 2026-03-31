/* eslint-disable @typescript-eslint/no-explicit-any */

import { Attachment } from "../../logger";
import { SpanTypeAttribute } from "../../../util";
import { aiSDKChannels } from "../../instrumentation/plugins/ai-sdk-channels";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
} from "../attachment-utils";
import { zodToJsonSchema } from "../../zod/utils";
import { normalizeAISDKLoggedOutput } from "./normalize-logged-output";
import { serializeAISDKToolsForLogging } from "./tool-serialization";
import type {
  AISDK,
  AISDKAgentClass,
  AISDKAgentInstance,
  AISDKCallParams,
  AISDKGeneratedFile,
  AISDKGenerateFunction,
  AISDKModel,
  AISDKOutputObject,
  AISDKOutputResponseFormat,
  AISDKResult,
  AISDKStreamFunction,
} from "../../vendor-sdk-types/ai-sdk";

// list of json paths to remove from output field
const DENY_OUTPUT_PATHS: string[] = [
  // v3
  "roundtrips[].request.body",
  "roundtrips[].response.headers",
  "rawResponse.headers",
  "responseMessages",
  // v5
  "request.body",
  "response.body",
  "response.headers",
  "steps[].request.body",
  "steps[].response.body",
  "steps[].response.headers",
];

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
 * Wraps Vercel AI SDK methods with Braintrust tracing. Returns wrapped versions
 * of generateText, streamText, generateObject, streamObject, Agent, experimental_Agent,
 * and ToolLoopAgent that automatically create spans and log inputs, outputs, and metrics.
 *
 * @param ai - The AI SDK namespace (e.g., import * as ai from "ai")
 * @returns Object with AI SDK methods with Braintrust tracing
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
      aiSDKChannels.streamTextSync,
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

const makeStreamWrapper = (
  asyncChannel:
    | typeof aiSDKChannels.streamText
    | typeof aiSDKChannels.streamObject
    | typeof aiSDKChannels.agentStream
    | typeof aiSDKChannels.toolLoopAgentStream,
  syncChannel:
    | typeof aiSDKChannels.streamTextSync
    | typeof aiSDKChannels.streamObjectSync,
  name: string,
  streamText: AISDKStreamFunction,
  contextOptions: {
    aiSDK?: AISDK;
    self?: unknown;
    spanType?: SpanTypeAttribute;
  } = {},
  options: WrapAISDKOptions = {},
) => {
  const useAsyncChannel = isAsyncFunction(streamText);

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

    if (useAsyncChannel) {
      return asyncChannel.tracePromise(
        () => Promise.resolve(streamText(tracedParams)),
        context,
      );
    }

    return syncChannel.traceSync(() => streamText(tracedParams), context);
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
    aiSDKChannels.streamTextSync,
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
    aiSDKChannels.streamObjectSync,
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

function isAsyncFunction(fn: unknown): boolean {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

function createAISDKChannelContext(
  params: AISDKCallParams,
  context: {
    aiSDK?: AISDK;
    denyOutputPaths?: string[];
    self?: unknown;
    span_info?: SpanInfo["span_info"];
  } = {},
) {
  return {
    arguments: [params] as [AISDKCallParams],
    ...(context.aiSDK ? { aiSDK: context.aiSDK } : {}),
    ...(context.denyOutputPaths
      ? { denyOutputPaths: context.denyOutputPaths }
      : {}),
    ...(context.self !== undefined ? { self: context.self } : {}),
    ...(context.span_info ? { span_info: context.span_info } : {}),
  };
}

/**
 * Parses a gateway model string like "openai/gpt-5-mini" into provider and model.
 * Returns { provider, model } if parseable, otherwise { model } only.
 */
function _parseGatewayModelString(modelString: string): {
  model: string;
  provider?: string;
} {
  if (!modelString || typeof modelString !== "string") {
    return { model: modelString };
  }
  const slashIndex = modelString.indexOf("/");
  if (slashIndex > 0 && slashIndex < modelString.length - 1) {
    return {
      provider: modelString.substring(0, slashIndex),
      model: modelString.substring(slashIndex + 1),
    };
  }
  return { model: modelString };
}

/**
 * Extracts model ID and effective provider from a model object or string.
 * Provider precedence: model.provider > parsed from gateway-style modelId string.
 *
 * @param model - Either a model object (with modelId and optional provider) or a model string
 */
function _serializeModelWithProvider(model: AISDKModel | undefined): {
  model: string | undefined;
  provider?: string;
} {
  const modelId = typeof model === "string" ? model : model?.modelId;
  // Provider can be set directly on the model object (e.g., AI SDK model instances)
  const explicitProvider =
    typeof model === "object" ? model?.provider : undefined;

  if (!modelId) {
    return { model: modelId, provider: explicitProvider };
  }

  const parsed = _parseGatewayModelString(modelId);
  return {
    model: parsed.model,
    provider: explicitProvider || parsed.provider,
  };
}

/**
 * Extracts gateway routing info from the result's providerMetadata.
 * This provides the actual resolved provider and model used by the gateway.
 */
function _extractGatewayRoutingInfo(result: AISDKResult): {
  model?: string;
  provider?: string;
} | null {
  // Check steps for gateway routing info (multi-step results)
  if (result?.steps && Array.isArray(result.steps) && result.steps.length > 0) {
    const routing = result.steps[0]?.providerMetadata?.gateway?.routing;
    if (routing) {
      return {
        provider: routing.resolvedProvider || routing.finalProvider,
        model: routing.resolvedProviderApiModelId,
      };
    }
  }

  // Check direct providerMetadata (single-step results)
  const routing = result?.providerMetadata?.gateway?.routing;
  if (routing) {
    return {
      provider: routing.resolvedProvider || routing.finalProvider,
      model: routing.resolvedProviderApiModelId,
    };
  }

  return null;
}

/**
 * Detects if an object is a Zod schema
 * Zod schemas have a _def property and are objects
 */
const isZodSchema = (value: any): boolean => {
  return (
    value != null &&
    typeof value === "object" &&
    "_def" in value &&
    typeof value._def === "object"
  );
};

/**
 * Converts a Zod schema to JSON Schema for serialization
 * This prevents errors when logging tools with Zod schemas
 */
const serializeZodSchema = (schema: unknown): AISDKOutputResponseFormat => {
  try {
    return zodToJsonSchema(schema as any) as AISDKOutputResponseFormat;
  } catch {
    // If conversion fails, return a placeholder
    return {
      type: "object",
      description: "Zod schema (conversion failed)",
    };
  }
};

/**
 * Detects if an object is an AI SDK Output object (from Output.object() or Output.text())
 * Output objects have a responseFormat property (function, object, or Promise).
 * AI SDK v5: { type: "object", responseFormat: { type: "json", schema: {...} } }
 * AI SDK v6: { responseFormat: Promise<{ type: "json", schema: {...} }> }
 */
const isOutputObject = (value: unknown): value is AISDKOutputObject => {
  if (value == null || typeof value !== "object") {
    return false;
  }

  const output = value as AISDKOutputObject;

  // Check for responseFormat property - this is the key indicator
  if (!("responseFormat" in output)) {
    return false;
  }

  // v5: Has type: "object" or "text"
  if (output.type === "object" || output.type === "text") {
    return true;
  }

  // v6 and other cases: responseFormat is a Promise, object, or function
  if (
    typeof output.responseFormat === "function" ||
    typeof output.responseFormat === "object"
  ) {
    return true;
  }

  return false;
};

/**
 * Serializes an AI SDK Output object for logging
 * Extracts the response format including schema for structured outputs
 * Handles v5 (plain object), v6 (Promise), and function-based responseFormat
 */
const serializeOutputObject = (
  output: AISDKOutputObject,
  model: AISDKModel | undefined,
): {
  type?: string;
  response_format:
    | AISDKOutputResponseFormat
    | Promise<AISDKOutputResponseFormat>
    | null;
} => {
  try {
    const result: {
      type?: string;
      response_format:
        | AISDKOutputResponseFormat
        | Promise<AISDKOutputResponseFormat>
        | null;
    } = {
      response_format: null,
    };

    // Include type if present (v5 has this)
    if (output.type) {
      result.type = output.type;
    }

    // responseFormat can be:
    // 1. A function (edge case) - need to call it
    // 2. A Promise (v6) - return the Promise to be resolved by logger
    // 3. A plain object (v5) - can use directly
    let responseFormat:
      | AISDKOutputResponseFormat
      | Promise<AISDKOutputResponseFormat>
      | undefined;

    if (typeof output.responseFormat === "function") {
      // Call responseFormat to get the schema
      // For logging purposes, we create a mock model that claims to support structured outputs
      // to ensure we always extract the schema when available
      const mockModelForSchema = {
        supportsStructuredOutputs: true,
        ...(model && typeof model === "object" ? model : {}),
      };
      responseFormat = output.responseFormat({ model: mockModelForSchema });
    } else if (
      output.responseFormat != null &&
      typeof output.responseFormat === "object"
    ) {
      // Could be a Promise or a plain object
      responseFormat = output.responseFormat;
    }

    if (responseFormat) {
      // If responseFormat is a Promise (v6), wrap it to handle Zod schema conversion
      if (typeof responseFormat.then === "function") {
        // Return a Promise that resolves to the formatted output
        // The logger will need to handle this Promise
        result.response_format = Promise.resolve(responseFormat).then(
          (resolved) => {
            // Convert Zod schema to JSON Schema if needed
            if (resolved.schema && isZodSchema(resolved.schema)) {
              return {
                ...resolved,
                schema: serializeZodSchema(resolved.schema),
              };
            }
            return resolved;
          },
        );
      } else {
        // Plain object - convert Zod schema if needed
        const syncResponseFormat = responseFormat as AISDKOutputResponseFormat;
        if (
          syncResponseFormat.schema &&
          isZodSchema(syncResponseFormat.schema)
        ) {
          responseFormat = {
            ...syncResponseFormat,
            schema: serializeZodSchema(syncResponseFormat.schema),
          };
        }
        result.response_format = responseFormat;
      }
    }

    return result;
  } catch {
    // If extraction fails, return a minimal representation
    return {
      response_format: null,
    };
  }
};

/**
 * Result from sync input processing.
 * For v6, includes a Promise to resolve the async output schema.
 */
export interface ProcessInputSyncResult {
  input: AISDKCallParams;
  // v6: Promise that resolves to { output: { response_format: {...} } } when available
  outputPromise?: Promise<{
    output: {
      response_format: AISDKOutputResponseFormat;
    };
  }>;
}

/**
 * Synchronous version of processInputAttachments for stream wrappers.
 * For v5: responseFormat is a plain object - captured fully
 * For v6: responseFormat is a Promise - returns initial input + Promise for update
 */
export const processInputAttachmentsSync = (
  input: AISDKCallParams,
): ProcessInputSyncResult => {
  if (!input) return { input };

  const processed: AISDKCallParams = { ...input };

  // Process messages array if present
  if (input.messages && Array.isArray(input.messages)) {
    processed.messages = input.messages.map(processMessage);
  }

  // Process prompt - can be an array of messages (provider-level format) or an object
  if (input.prompt && typeof input.prompt === "object") {
    if (Array.isArray(input.prompt)) {
      // Provider-level format: prompt is an array of messages
      processed.prompt = input.prompt.map(processMessage);
    } else {
      // High-level format: prompt is an object with potential attachments
      processed.prompt = processPromptContent(input.prompt);
    }
  }

  // Process schema (used by generateObject/streamObject) to convert Zod to JSON Schema
  if (input.schema && isZodSchema(input.schema)) {
    processed.schema = serializeZodSchema(input.schema);
  }

  // Process callOptionsSchema (used by ToolLoopAgent and other agents)
  if (input.callOptionsSchema && isZodSchema(input.callOptionsSchema)) {
    processed.callOptionsSchema = serializeZodSchema(input.callOptionsSchema);
  }

  if (input.tools) {
    processed.tools = serializeAISDKToolsForLogging(input.tools);
  }

  // Track if we need async resolution for v6
  let outputPromise:
    | Promise<{
        output: {
          response_format: AISDKOutputResponseFormat;
        };
      }>
    | undefined;

  // Process output schema for generateText/streamText with Output.object()
  // v5: responseFormat is a plain object with schema - serialize it
  // v6: responseFormat is a Promise - store placeholder and return Promise for update
  if (input.output && isOutputObject(input.output)) {
    const serialized = serializeOutputObject(input.output, input.model);

    // Check if response_format is a Promise (v6)
    if (
      serialized.response_format &&
      typeof serialized.response_format.then === "function"
    ) {
      // v6: Store placeholder now, resolve Promise for later update
      processed.output = { ...serialized, response_format: {} };
      outputPromise = serialized.response_format.then(
        (resolvedFormat: AISDKOutputResponseFormat) => ({
          output: { ...serialized, response_format: resolvedFormat },
        }),
      );
    } else {
      // v5: response_format is already resolved
      processed.output = serialized;
    }
  }

  // Remove prepareCall function from logs (not serializable and not useful)
  if (
    "prepareCall" in processed &&
    typeof processed.prepareCall === "function"
  ) {
    processed.prepareCall = "[Function]";
  }

  return { input: processed, outputPromise };
};

const processMessage = (message: any): any => {
  if (!message || typeof message !== "object") return message;

  // If content is an array, process each content part
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map(processContentPart),
    };
  }

  // If content is an object (single content part), process it
  if (typeof message.content === "object" && message.content !== null) {
    return {
      ...message,
      content: processContentPart(message.content),
    };
  }

  return message;
};

const processPromptContent = (prompt: any): any => {
  // Handle prompt objects that might contain content arrays
  if (Array.isArray(prompt)) {
    return prompt.map(processContentPart);
  }

  if (prompt.content) {
    if (Array.isArray(prompt.content)) {
      return {
        ...prompt,
        content: prompt.content.map(processContentPart),
      };
    } else if (typeof prompt.content === "object") {
      return {
        ...prompt,
        content: processContentPart(prompt.content),
      };
    }
  }

  return prompt;
};

const processContentPart = (part: any): any => {
  if (!part || typeof part !== "object") return part;

  try {
    // Process image content with data URLs (these have explicit mime types)
    if (part.type === "image" && part.image) {
      const imageAttachment = convertImageToAttachment(
        part.image,
        part.mimeType || part.mediaType,
      );
      if (imageAttachment) {
        return {
          ...part,
          image: imageAttachment,
        };
      }
    }

    // Process file content with explicit mime type
    if (
      part.type === "file" &&
      part.data &&
      (part.mimeType || part.mediaType)
    ) {
      const fileAttachment = convertDataToAttachment(
        part.data,
        part.mimeType || part.mediaType,
        part.name || part.filename,
      );
      if (fileAttachment) {
        return {
          ...part,
          data: fileAttachment,
        };
      }
    }

    // Process image_url format (OpenAI style)
    if (part.type === "image_url" && part.image_url) {
      if (typeof part.image_url === "object" && part.image_url.url) {
        const imageAttachment = convertImageToAttachment(part.image_url.url);
        if (imageAttachment) {
          return {
            ...part,
            image_url: {
              ...part.image_url,
              url: imageAttachment,
            },
          };
        }
      }
    }
  } catch (error) {
    console.warn("Error processing content part:", error);
  }

  return part;
};

const convertImageToAttachment = (
  image: any,
  explicitMimeType?: string,
): Attachment | null => {
  try {
    // Handle data URLs (they contain their own mime type)
    if (typeof image === "string" && image.startsWith("data:")) {
      const [mimeTypeSection, base64Data] = image.split(",");
      const mimeType = mimeTypeSection.match(/data:(.*?);/)?.[1];
      if (mimeType && base64Data) {
        const blob = convertDataToBlob(base64Data, mimeType);
        if (blob) {
          return new Attachment({
            data: blob,
            filename: `image.${getExtensionFromMediaType(mimeType)}`,
            contentType: mimeType,
          });
        }
      }
    }

    // Only convert binary data if we have an explicit mime type
    if (explicitMimeType) {
      // Handle Uint8Array
      if (image instanceof Uint8Array) {
        return new Attachment({
          data: new Blob([image], { type: explicitMimeType }),
          filename: `image.${getExtensionFromMediaType(explicitMimeType)}`,
          contentType: explicitMimeType,
        });
      }

      // Handle Buffer (Node.js)
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(image)) {
        return new Attachment({
          data: new Blob([image], { type: explicitMimeType }),
          filename: `image.${getExtensionFromMediaType(explicitMimeType)}`,
          contentType: explicitMimeType,
        });
      }
    }

    // Handle Blob (has its own type)
    if (image instanceof Blob && image.type) {
      return new Attachment({
        data: image,
        filename: `image.${getExtensionFromMediaType(image.type)}`,
        contentType: image.type,
      });
    }

    // If already an Attachment, return as-is
    if (image instanceof Attachment) {
      return image;
    }
  } catch (error) {
    console.warn("Error converting image to attachment:", error);
  }

  return null;
};

const convertDataToAttachment = (
  data: any,
  mimeType: string,
  filename?: string,
): Attachment | null => {
  if (!mimeType) return null; // Don't convert without explicit mime type

  try {
    let blob: Blob | null = null;

    // Handle data URLs
    if (typeof data === "string" && data.startsWith("data:")) {
      const [, base64Data] = data.split(",");
      if (base64Data) {
        blob = convertDataToBlob(base64Data, mimeType);
      }
    }
    // Handle plain base64 strings
    else if (typeof data === "string" && data.length > 0) {
      blob = convertDataToBlob(data, mimeType);
    }
    // Handle Uint8Array
    else if (data instanceof Uint8Array) {
      blob = new Blob([data], { type: mimeType });
    }
    // Handle Buffer (Node.js)
    else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      blob = new Blob([data], { type: mimeType });
    }
    // Handle Blob
    else if (data instanceof Blob) {
      blob = data;
    }

    if (blob) {
      return new Attachment({
        data: blob,
        filename: filename || `file.${getExtensionFromMediaType(mimeType)}`,
        contentType: mimeType,
      });
    }
  } catch (error) {
    console.warn("Error converting data to attachment:", error);
  }

  return null;
};

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number") {
      return v;
    }
  }
  return undefined;
}

/**
 * Extracts all token metrics from usage data.
 * Handles various provider formats and naming conventions for token counts.
 */
export function extractTokenMetrics(
  result: AISDKResult,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  // Agent results use totalUsage, other results use usage
  // Try totalUsage first (for Agent calls), then fall back to usage
  let usage = result?.totalUsage || result?.usage;

  // If usage is not directly accessible, try as a getter
  if (!usage && result) {
    try {
      if ("totalUsage" in result && typeof result.totalUsage !== "function") {
        usage = result.totalUsage;
      } else if ("usage" in result && typeof result.usage !== "function") {
        usage = result.usage;
      }
    } catch {
      // Ignore errors accessing getters
    }
  }

  if (!usage) {
    return metrics;
  }

  // Prompt tokens (AI SDK v5 uses inputTokens, which can be a number or object with .total)
  const promptTokens = firstNumber(
    usage.inputTokens?.total,
    usage.inputTokens,
    usage.promptTokens,
    usage.prompt_tokens,
  );
  if (promptTokens !== undefined) {
    metrics.prompt_tokens = promptTokens;
  }

  // Completion tokens (AI SDK v5 uses outputTokens, which can be a number or object with .total)
  const completionTokens = firstNumber(
    usage.outputTokens?.total,
    usage.outputTokens,
    usage.completionTokens,
    usage.completion_tokens,
  );
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }

  // Total tokens
  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.tokens,
    usage.total_tokens,
  );
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  }

  // Prompt cached tokens (can be nested in inputTokens.cacheRead or top-level)
  const promptCachedTokens = firstNumber(
    usage.inputTokens?.cacheRead,
    usage.cachedInputTokens,
    usage.promptCachedTokens,
    usage.prompt_cached_tokens,
  );
  if (promptCachedTokens !== undefined) {
    metrics.prompt_cached_tokens = promptCachedTokens;
  }

  // Prompt cache creation tokens
  const promptCacheCreationTokens = firstNumber(
    usage.promptCacheCreationTokens,
    usage.prompt_cache_creation_tokens,
  );
  if (promptCacheCreationTokens !== undefined) {
    metrics.prompt_cache_creation_tokens = promptCacheCreationTokens;
  }

  // Prompt reasoning tokens
  const promptReasoningTokens = firstNumber(
    usage.promptReasoningTokens,
    usage.prompt_reasoning_tokens,
  );
  if (promptReasoningTokens !== undefined) {
    metrics.prompt_reasoning_tokens = promptReasoningTokens;
  }

  // Completion cached tokens
  const completionCachedTokens = firstNumber(
    usage.completionCachedTokens,
    usage.completion_cached_tokens,
  );
  if (completionCachedTokens !== undefined) {
    metrics.completion_cached_tokens = completionCachedTokens;
  }

  // Completion reasoning tokens (can be nested in outputTokens.reasoning)
  const reasoningTokenCount = firstNumber(
    usage.outputTokens?.reasoning,
    usage.reasoningTokens,
    usage.completionReasoningTokens,
    usage.completion_reasoning_tokens,
    usage.reasoning_tokens,
    usage.thinkingTokens,
    usage.thinking_tokens,
  );
  if (reasoningTokenCount !== undefined) {
    metrics.completion_reasoning_tokens = reasoningTokenCount;
    metrics.reasoning_tokens = reasoningTokenCount;
  }

  // Completion audio tokens
  const completionAudioTokens = firstNumber(
    usage.completionAudioTokens,
    usage.completion_audio_tokens,
  );
  if (completionAudioTokens !== undefined) {
    metrics.completion_audio_tokens = completionAudioTokens;
  }

  // Extract cost from providerMetadata.gateway.cost (e.g., from Vercel AI Gateway)
  // For multi-step results, sum up costs from all steps
  const cost = extractCostFromResult(result);
  if (cost !== undefined) {
    metrics.estimated_cost = cost;
  }

  return metrics;
}

function extractCostFromResult(result: AISDKResult): number | undefined {
  // Check for cost in steps (multi-step results like generateText with tools)
  if (result?.steps && Array.isArray(result.steps) && result.steps.length > 0) {
    let totalCost = 0;
    let foundCost = false;
    for (const step of result.steps) {
      const gateway = step?.providerMetadata?.gateway;
      // Check cost first, then fall back to marketCost (Vercel AI Gateway)
      const stepCost =
        parseGatewayCost(gateway?.cost) ||
        parseGatewayCost(gateway?.marketCost);
      if (stepCost !== undefined && stepCost > 0) {
        totalCost += stepCost;
        foundCost = true;
      }
    }
    if (foundCost) {
      return totalCost;
    }
  }

  // Check for cost directly on result.providerMetadata (single-step results)
  const gateway = result?.providerMetadata?.gateway;
  // Check cost first, then fall back to marketCost (Vercel AI Gateway)
  const directCost =
    parseGatewayCost(gateway?.cost) || parseGatewayCost(gateway?.marketCost);
  if (directCost !== undefined && directCost > 0) {
    return directCost;
  }

  return undefined;
}

function parseGatewayCost(cost: unknown): number | undefined {
  if (cost === undefined || cost === null) {
    return undefined;
  }
  if (typeof cost === "number") {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = parseFloat(cost);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

const deepCopy = (obj: Record<string, unknown>) => {
  return JSON.parse(JSON.stringify(obj));
};

const parsePath = (path: string): (string | number)[] => {
  const keys: (string | number)[] = [];
  let current = "";

  for (let i = 0; i < path.length; i++) {
    const char = path[i];

    if (char === ".") {
      if (current) {
        keys.push(current);
        current = "";
      }
    } else if (char === "[") {
      if (current) {
        keys.push(current);
        current = "";
      }
      let bracketContent = "";
      i++;
      while (i < path.length && path[i] !== "]") {
        bracketContent += path[i];
        i++;
      }
      if (bracketContent === "") {
        keys.push("[]");
      } else {
        const index = parseInt(bracketContent, 10);
        keys.push(isNaN(index) ? bracketContent : index);
      }
    } else {
      current += char;
    }
  }

  if (current) {
    keys.push(current);
  }

  return keys;
};

const omitAtPath = (obj: any, keys: (string | number)[]): void => {
  if (keys.length === 0) return;

  const firstKey = keys[0];
  const remainingKeys = keys.slice(1);

  if (firstKey === "[]") {
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (remainingKeys.length > 0) {
          omitAtPath(item, remainingKeys);
        }
      });
    }
  } else if (remainingKeys.length === 0) {
    if (obj && typeof obj === "object" && firstKey in obj) {
      obj[firstKey] = "<omitted>";
    }
  } else {
    if (obj && typeof obj === "object" && firstKey in obj) {
      omitAtPath(obj[firstKey], remainingKeys);
    }
  }
};

export const omit = (obj: Record<string, unknown>, paths: string[]) => {
  const result = deepCopy(obj);

  for (const path of paths) {
    const keys = parsePath(path);
    omitAtPath(result, keys);
  }

  return result;
};
