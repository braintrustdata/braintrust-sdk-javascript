/* eslint-disable @typescript-eslint/no-explicit-any */

import { startSpan, traced, withCurrent, Attachment } from "../../logger";
import { SpanTypeAttribute } from "../../../util";
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
  AISDKLanguageModel,
  AISDKModel,
  AISDKModelStreamChunk,
  AISDKOutputObject,
  AISDKOutputResponseFormat,
  AISDKResult,
  AISDKStreamFunction,
  AISDKTool,
  AISDKTools,
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
  return async (params: AISDKCallParams) =>
    makeGenerateTextWrapper(
      `${instance.constructor.name}.generate`,
      options,
      generate.bind(instance), // as of v5 this is just streamText under the hood
      // Follows what the AI SDK does under the hood when calling generateText
      undefined,
      SpanTypeAttribute.FUNCTION,
    )({ ...instance.settings, ...params });
};

const wrapAgentStream = (
  stream: AISDKStreamFunction,
  instance: AISDKAgentInstance,
  options: WrapAISDKOptions = {},
) => {
  return (params: AISDKCallParams) =>
    makeStreamTextWrapper(
      `${instance.constructor.name}.stream`,
      options,
      stream.bind(instance), // as of v5 this is just streamText under the hood
      undefined, // aiSDK not needed since model is already on instance
      SpanTypeAttribute.FUNCTION,
    )({ ...instance.settings, ...params });
};

const makeGenerateTextWrapper = (
  name: string,
  options: WrapAISDKOptions,
  generateText: AISDKGenerateFunction,
  aiSDK?: AISDK,
  spanType: SpanTypeAttribute = SpanTypeAttribute.LLM,
) => {
  const wrapper = async function (allParams: AISDKCallParams & SpanInfo) {
    // Extract span_info from params (used by Braintrust-managed prompts)
    const { span_info, ...params } = allParams;
    const {
      metadata: spanInfoMetadata,
      name: spanName,
      spanAttributes: spanInfoAttrs,
    } = span_info ?? {};

    const { model, provider } = serializeModelWithProvider(params.model);
    const serializedTools = serializeAISDKToolsForLogging(params.tools);

    // Process input attachments (including async Output.object resolution for v6)
    const processedInput = await processInputAttachments(params);

    return traced(
      async (span) => {
        const { wrappedModel, getMetrics } = wrapModelAndGetMetrics(
          params.model,
          aiSDK,
        );

        const result = await generateText({
          ...params,
          model: wrappedModel,
          tools: wrapTools(params.tools),
        });

        // Extract resolved model/provider from gateway routing if available
        const gatewayInfo = extractGatewayRoutingInfo(result);
        const resolvedMetadata: Record<string, unknown> = {};
        if (gatewayInfo?.provider) {
          resolvedMetadata.provider = gatewayInfo.provider;
        }
        if (gatewayInfo?.model) {
          resolvedMetadata.model = gatewayInfo.model;
        }

        span.log({
          output: await processOutput(result, options.denyOutputPaths),
          metrics: getMetrics(result),
          ...(Object.keys(resolvedMetadata).length > 0
            ? { metadata: resolvedMetadata }
            : {}),
        });

        return result;
      },
      {
        name: spanName || name,
        spanAttributes: {
          type: spanType,
          ...spanInfoAttrs,
        },
        event: {
          input: processedInput,
          metadata: {
            ...spanInfoMetadata,
            model,
            ...(provider ? { provider } : {}),
            ...(serializedTools ? { tools: serializedTools } : {}),
            braintrust: {
              integration_name: "ai-sdk",
              sdk_language: "typescript",
            },
          },
        },
      },
    );
  };
  Object.defineProperty(wrapper, "name", { value: name, writable: false });
  return wrapper;
};

/**
 * Resolves a model string ID to a model instance using AI SDK's global provider.
 * This mirrors the internal resolveLanguageModel function in AI SDK.
 */
const resolveModel = (
  model: AISDKModel | undefined,
  ai?: AISDK,
): AISDKModel | undefined => {
  if (typeof model !== "string") {
    return model;
  }
  // Use AI SDK's global provider if set, otherwise fall back to gateway
  const provider =
    (
      globalThis as typeof globalThis & {
        AI_SDK_DEFAULT_PROVIDER?: {
          languageModel?: (modelId: string) => AISDKLanguageModel;
        };
      }
    ).AI_SDK_DEFAULT_PROVIDER ??
    ai?.gateway ??
    null;
  if (provider && typeof provider.languageModel === "function") {
    return provider.languageModel(model);
  }
  // If no provider available, return as-is (AI SDK will resolve it)
  return model;
};

/**
 * Wraps a model's doGenerate method to create a span for each LLM call.
 * This allows visibility into each step of a multi-round tool interaction.
 */
const wrapModel = (
  model: AISDKModel | undefined,
  ai?: AISDK,
): AISDKModel | undefined => {
  // Resolve string model IDs to model instances
  const resolvedModel = resolveModel(model, ai);

  if (
    !resolvedModel ||
    typeof resolvedModel !== "object" ||
    typeof resolvedModel.doGenerate !== "function"
  ) {
    return model; // Return original if we can't wrap
  }

  // Already wrapped - avoid double wrapping
  if (resolvedModel._braintrustWrapped) {
    return resolvedModel;
  }

  const originalDoGenerate = resolvedModel.doGenerate.bind(resolvedModel);
  const originalDoStream = resolvedModel.doStream?.bind(resolvedModel);

  const { model: modelId, provider } =
    serializeModelWithProvider(resolvedModel);

  const wrappedDoGenerate = async (options: AISDKCallParams) => {
    const serializedTools = serializeAISDKToolsForLogging(options.tools);
    // Process input attachments (including async Output.object resolution for v6)
    const processedInput = await processInputAttachments(options);

    return traced(
      async (span) => {
        const result = await originalDoGenerate(options);

        // Extract resolved model/provider from gateway routing if available
        const gatewayInfo = extractGatewayRoutingInfo(result);
        const resolvedMetadata: Record<string, unknown> = {};
        if (gatewayInfo?.provider) {
          resolvedMetadata.provider = gatewayInfo.provider;
        }
        if (gatewayInfo?.model) {
          resolvedMetadata.model = gatewayInfo.model;
        }
        if (result.finishReason !== undefined) {
          resolvedMetadata.finish_reason = result.finishReason;
        }

        span.log({
          output: await processOutput(result),
          metrics: extractTokenMetrics(result),
          ...(Object.keys(resolvedMetadata).length > 0
            ? { metadata: resolvedMetadata }
            : {}),
        });

        return result;
      },
      {
        name: "doGenerate",
        spanAttributes: {
          type: SpanTypeAttribute.LLM,
        },
        event: {
          input: processedInput,
          metadata: {
            model: modelId,
            ...(provider ? { provider } : {}),
            ...(serializedTools ? { tools: serializedTools } : {}),
            braintrust: {
              integration_name: "ai-sdk",
              sdk_language: "typescript",
            },
          },
        },
      },
    );
  };

  const wrappedDoStream = async (options: AISDKCallParams) => {
    const startTime = Date.now();
    let receivedFirst = false;
    const serializedTools = serializeAISDKToolsForLogging(options.tools);

    // Process input attachments (including async Output.object resolution for v6)
    const processedInput = await processInputAttachments(options);

    const span = startSpan({
      name: "doStream",
      spanAttributes: {
        type: SpanTypeAttribute.LLM,
      },
      event: {
        input: processedInput,
        metadata: {
          model: modelId,
          ...(provider ? { provider } : {}),
          ...(serializedTools ? { tools: serializedTools } : {}),
          braintrust: {
            integration_name: "ai-sdk",
            sdk_language: "typescript",
          },
        },
      },
    });

    const result = await originalDoStream!(options);

    // Accumulate streamed content for output logging
    const output: Record<string, unknown> = {};
    let text = "";
    let reasoning = "";
    const toolCalls: unknown[] = [];
    let object: unknown = undefined; // For structured output / streamObject

    // Helper to extract text from various chunk formats
    const extractTextDelta = (chunk: AISDKModelStreamChunk): string => {
      // Try all known property names for text deltas
      if (typeof chunk.textDelta === "string") return chunk.textDelta;
      if (typeof chunk.delta === "string") return chunk.delta;
      if (typeof chunk.text === "string") return chunk.text;
      // For content property (some providers use this)
      if (typeof chunk.content === "string") return chunk.content;
      return "";
    };

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        // Track time to first token on any chunk type
        if (!receivedFirst) {
          receivedFirst = true;
          span.log({
            metrics: {
              time_to_first_token: (Date.now() - startTime) / 1000,
            },
          });
        }

        switch (chunk.type) {
          case "text-delta":
            text += extractTextDelta(chunk);
            break;
          case "reasoning-delta":
            // Reasoning chunks use delta or text property
            if (chunk.delta) {
              reasoning += chunk.delta;
            } else if (chunk.text) {
              reasoning += chunk.text;
            }
            break;
          case "tool-call":
            toolCalls.push(chunk);
            break;
          case "object":
            // Structured output - capture the final object
            object = chunk.object;
            break;
          case "raw":
            // Raw chunks may contain text content for structured output / JSON mode
            // The rawValue often contains the delta text from the provider
            if (chunk.rawValue) {
              const rawVal = chunk.rawValue;
              // OpenAI format: rawValue.delta.content or rawValue.choices[0].delta.content
              if (rawVal.delta?.content) {
                text += rawVal.delta.content;
              } else if (rawVal.choices?.[0]?.delta?.content) {
                text += rawVal.choices[0].delta.content;
              } else if (typeof rawVal.text === "string") {
                text += rawVal.text;
              } else if (typeof rawVal.content === "string") {
                text += rawVal.content;
              }
            }
            break;
          case "finish":
            output.text = text;
            output.reasoning = reasoning;
            output.toolCalls = toolCalls;
            output.finishReason = chunk.finishReason;
            output.usage = chunk.usage;

            // Include object for structured output if captured
            if (object !== undefined) {
              output.object = object;
            }

            // Extract resolved model/provider from gateway routing if available
            const gatewayInfo = extractGatewayRoutingInfo(output);
            const resolvedMetadata: Record<string, unknown> = {};
            if (gatewayInfo?.provider) {
              resolvedMetadata.provider = gatewayInfo.provider;
            }
            if (gatewayInfo?.model) {
              resolvedMetadata.model = gatewayInfo.model;
            }
            if (chunk.finishReason !== undefined) {
              resolvedMetadata.finish_reason = chunk.finishReason;
            }

            span.log({
              output: await processOutput(output),
              metrics: extractTokenMetrics(output as AISDKResult),
              ...(Object.keys(resolvedMetadata).length > 0
                ? { metadata: resolvedMetadata }
                : {}),
            });
            span.end();
            break;
        }
        controller.enqueue(chunk);
      },
    });

    return {
      ...result,
      stream: result.stream.pipeThrough(transformStream),
    };
  };

  return new Proxy(resolvedModel, {
    get(target, prop, receiver) {
      if (prop === "_braintrustWrapped") {
        return true;
      }
      if (prop === "doGenerate") {
        return wrappedDoGenerate;
      }
      if (prop === "doStream" && originalDoStream) {
        return wrappedDoStream;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
};

const wrapGenerateText = (
  generateText: AISDKGenerateFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeGenerateTextWrapper("generateText", options, generateText, aiSDK);
};

/**
 * Wraps the model and returns a metrics extractor for the parent span.
 * When the model is wrapped, child doGenerate/doStream spans already carry
 * token/cost metrics, so the extractor returns undefined to prevent
 * double-counting on the parent.
 */
const wrapModelAndGetMetrics = (
  model: AISDKModel | undefined,
  aiSDK?: AISDK,
): {
  wrappedModel: AISDKModel | undefined;
  getMetrics: (result: AISDKResult) => Record<string, number> | undefined;
} => {
  const wrappedModel = wrapModel(model, aiSDK);
  const modelIsWrapped =
    typeof wrappedModel === "object" &&
    wrappedModel !== null &&
    wrappedModel._braintrustWrapped === true;
  return {
    wrappedModel,
    getMetrics: (result: AISDKResult) =>
      modelIsWrapped ? undefined : extractTokenMetrics(result),
  };
};

const wrapGenerateObject = (
  generateObject: AISDKGenerateFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return async function generateObjectWrapper(
    allParams: AISDKCallParams & SpanInfo,
  ) {
    // Extract span_info from params (used by Braintrust-managed prompts)
    const { span_info, ...params } = allParams;
    const {
      metadata: spanInfoMetadata,
      name: spanName,
      spanAttributes: spanInfoAttrs,
    } = span_info ?? {};

    const { model, provider } = serializeModelWithProvider(params.model);
    const serializedTools = serializeAISDKToolsForLogging(params.tools);

    // Process input attachments (including async Output.object resolution for v6)
    const processedInput = await processInputAttachments(params);

    return traced(
      async (span) => {
        const { wrappedModel, getMetrics } = wrapModelAndGetMetrics(
          params.model,
          aiSDK,
        );

        const result = await generateObject({
          ...params,
          model: wrappedModel,
          tools: wrapTools(params.tools),
        });

        const output = await processOutput(result, options.denyOutputPaths);

        // Extract resolved model/provider from gateway routing if available
        const gatewayInfo = extractGatewayRoutingInfo(result);
        const resolvedMetadata: Record<string, unknown> = {};
        if (gatewayInfo?.provider) {
          resolvedMetadata.provider = gatewayInfo.provider;
        }
        if (gatewayInfo?.model) {
          resolvedMetadata.model = gatewayInfo.model;
        }

        span.log({
          output,
          metrics: getMetrics(result),
          ...(Object.keys(resolvedMetadata).length > 0
            ? { metadata: resolvedMetadata }
            : {}),
        });

        return result;
      },
      {
        name: spanName || "generateObject",
        spanAttributes: {
          type: SpanTypeAttribute.LLM,
          ...spanInfoAttrs,
        },
        event: {
          input: processedInput,
          metadata: {
            ...spanInfoMetadata,
            model,
            ...(provider ? { provider } : {}),
            ...(serializedTools ? { tools: serializedTools } : {}),
            braintrust: {
              integration_name: "ai-sdk",
              sdk_language: "typescript",
            },
          },
        },
      },
    );
  };
};

const makeStreamTextWrapper = (
  name: string,
  options: WrapAISDKOptions,
  streamText: AISDKStreamFunction,
  aiSDK?: AISDK,
  spanType: SpanTypeAttribute = SpanTypeAttribute.LLM,
) => {
  // Note: streamText returns a sync result (stream object), so we cannot make this async
  // For v6, Output.object responseFormat is a Promise - we handle this by:
  // 1. Processing input synchronously (v5 works, v6 gets placeholder)
  // 2. Updating the span with resolved schema when Promise completes
  const wrapper = function (allParams: AISDKCallParams & SpanInfo) {
    // Extract span_info from params (used by Braintrust-managed prompts)
    const { span_info, ...params } = allParams;
    const {
      metadata: spanInfoMetadata,
      name: spanName,
      spanAttributes: spanInfoAttrs,
    } = span_info ?? {};

    const { model, provider } = serializeModelWithProvider(params.model);
    const serializedTools = serializeAISDKToolsForLogging(params.tools);

    // Process input attachments synchronously
    // v5: responseFormat is a plain object - captured fully
    // v6: responseFormat is a Promise - captured as placeholder, then updated when resolved
    const { input: processedInput, outputPromise } =
      processInputAttachmentsSync(params);

    const span = startSpan({
      name: spanName || name,
      spanAttributes: {
        type: spanType,
        ...spanInfoAttrs,
      },
      event: {
        input: processedInput,
        metadata: {
          ...spanInfoMetadata,
          model,
          ...(provider ? { provider } : {}),
          ...(serializedTools ? { tools: serializedTools } : {}),
          braintrust: {
            integration_name: "ai-sdk",
            sdk_language: "typescript",
          },
        },
      },
    });

    // v6: Update input with resolved output schema when Promise completes
    if (outputPromise) {
      outputPromise
        .then((resolvedData) => {
          span.log({ input: { ...processedInput, ...resolvedData } });
        })
        .catch(() => {
          // Silently ignore resolution errors - placeholder will be used
        });
    }

    try {
      const startTime = Date.now();
      let receivedFirst = false;
      const { wrappedModel, getMetrics } = wrapModelAndGetMetrics(
        params.model,
        aiSDK,
      );

      const result = withCurrent(span, () =>
        streamText({
          ...params,
          model: wrappedModel,
          tools: wrapTools(params.tools),
          onChunk: (chunk: AISDKModelStreamChunk) => {
            if (!receivedFirst) {
              receivedFirst = true;
              span.log({
                metrics: {
                  time_to_first_token: (Date.now() - startTime) / 1000,
                },
              });
            }

            params.onChunk?.(chunk);
          },
          onFinish: async (event: AISDKResult) => {
            params.onFinish?.(event);

            // Extract resolved model/provider from gateway routing if available
            const gatewayInfo = extractGatewayRoutingInfo(event);
            const resolvedMetadata: Record<string, unknown> = {};
            if (gatewayInfo?.provider) {
              resolvedMetadata.provider = gatewayInfo.provider;
            }
            if (gatewayInfo?.model) {
              resolvedMetadata.model = gatewayInfo.model;
            }

            span.log({
              output: await processOutput(event, options.denyOutputPaths),
              metrics: getMetrics(event),
              ...(Object.keys(resolvedMetadata).length > 0
                ? { metadata: resolvedMetadata }
                : {}),
            });

            span.end();
          },
          onError: async (err: unknown) => {
            params.onError?.(err);

            span.log({
              error: serializeError(err),
            });

            span.end();
          },
        }),
      );

      // Use stream tee to track first token regardless of consumption method
      const trackFirstToken = () => {
        if (!receivedFirst) {
          receivedFirst = true;
          span.log({
            metrics: {
              time_to_first_token: (Date.now() - startTime) / 1000,
            },
          });
        }
      };

      if (result && result.baseStream) {
        const [stream1, stream2] = result.baseStream.tee();
        result.baseStream = stream2;

        stream1
          .pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                trackFirstToken();
                controller.enqueue(chunk);
              },
            }),
          )
          .pipeTo(
            new WritableStream({
              write() {
                // Discard chunks - we only care about the side effect
              },
            }),
          )
          .catch(() => {
            // Silently ignore errors from the tracking stream
          });
      }

      return result;
    } catch (error) {
      span.log({
        error: serializeError(error),
      });
      span.end();
      throw error;
    }
  };
  Object.defineProperty(wrapper, "name", { value: name, writable: false });
  return wrapper;
};

const wrapStreamText = (
  streamText: AISDKStreamFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  return makeStreamTextWrapper("streamText", options, streamText, aiSDK);
};

const wrapStreamObject = (
  streamObject: AISDKStreamFunction,
  options: WrapAISDKOptions = {},
  aiSDK?: AISDK,
) => {
  // Note: streamObject returns a sync result (stream object), so we cannot make this async
  // For v6, Output.object responseFormat is a Promise - we handle this by:
  // 1. Processing input synchronously (v5 works, v6 gets placeholder)
  // 2. Updating the span with resolved schema when Promise completes
  return function streamObjectWrapper(allParams: AISDKCallParams & SpanInfo) {
    // Extract span_info from params (used by Braintrust-managed prompts)
    const { span_info, ...params } = allParams;
    const {
      metadata: spanInfoMetadata,
      name: spanName,
      spanAttributes: spanInfoAttrs,
    } = span_info ?? {};

    const { model, provider } = serializeModelWithProvider(params.model);
    const serializedTools = serializeAISDKToolsForLogging(params.tools);

    // Process input attachments synchronously
    // v5: responseFormat is a plain object - captured fully
    // v6: responseFormat is a Promise - captured as placeholder, then updated when resolved
    const { input: processedInput, outputPromise } =
      processInputAttachmentsSync(params);

    const span = startSpan({
      name: spanName || "streamObject",
      spanAttributes: {
        type: SpanTypeAttribute.LLM,
        ...spanInfoAttrs,
      },
      event: {
        input: processedInput,
        metadata: {
          ...spanInfoMetadata,
          model,
          ...(provider ? { provider } : {}),
          ...(serializedTools ? { tools: serializedTools } : {}),
          braintrust: {
            integration_name: "ai-sdk",
            sdk_language: "typescript",
          },
        },
      },
    });

    // v6: Update input with resolved output schema when Promise completes
    if (outputPromise) {
      outputPromise
        .then((resolvedData) => {
          span.log({ input: { ...processedInput, ...resolvedData } });
        })
        .catch(() => {
          // Silently ignore resolution errors - placeholder will be used
        });
    }

    try {
      const startTime = Date.now();
      let receivedFirst = false;
      const { wrappedModel, getMetrics } = wrapModelAndGetMetrics(
        params.model,
        aiSDK,
      );

      const result = withCurrent(span, () =>
        streamObject({
          ...params,
          model: wrappedModel,
          tools: wrapTools(params.tools),
          onChunk: (chunk: AISDKModelStreamChunk) => {
            if (!receivedFirst) {
              receivedFirst = true;
              span.log({
                metrics: {
                  time_to_first_token: (Date.now() - startTime) / 1000,
                },
              });
            }
            params.onChunk?.(chunk);
          },
          onFinish: async (event: AISDKResult) => {
            params.onFinish?.(event);

            // Extract resolved model/provider from gateway routing if available
            const gatewayInfo = extractGatewayRoutingInfo(event);
            const resolvedMetadata: Record<string, unknown> = {};
            if (gatewayInfo?.provider) {
              resolvedMetadata.provider = gatewayInfo.provider;
            }
            if (gatewayInfo?.model) {
              resolvedMetadata.model = gatewayInfo.model;
            }

            span.log({
              output: await processOutput(event, options.denyOutputPaths),
              metrics: getMetrics(event),
              ...(Object.keys(resolvedMetadata).length > 0
                ? { metadata: resolvedMetadata }
                : {}),
            });

            span.end();
          },
          onError: async (err: unknown) => {
            params.onError?.(err);

            span.log({
              error: serializeError(err),
            });

            span.end();
          },
        }),
      );

      // Use stream tee to track first token regardless of consumption method
      const trackFirstToken = () => {
        if (!receivedFirst) {
          receivedFirst = true;
          span.log({
            metrics: {
              time_to_first_token: (Date.now() - startTime) / 1000,
            },
          });
        }
      };

      if (result && result.baseStream) {
        const [stream1, stream2] = result.baseStream.tee();
        result.baseStream = stream2;

        stream1
          .pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                trackFirstToken();
                controller.enqueue(chunk);
              },
            }),
          )
          .pipeTo(
            new WritableStream({
              write() {
                // Discard chunks - we only care about the side effect
              },
            }),
          )
          .catch(() => {
            // Silently ignore errors from the tracking stream
          });
      }

      return result;
    } catch (error) {
      span.log({
        error: serializeError(error),
      });
      span.end();
      throw error;
    }
  };
};

/**
 * Wraps AI SDK tools with tracing support
 *
 * Supports all AI SDK versions (v3-v6):
 * - Tools created with ai.tool() or tool() helper (have execute function)
 * - Raw tool definitions with parameters only (v3-v4)
 * - RSC tools with render function (v3-v4)
 *
 * Tools with execute are wrapped with tracing; others are passed through as-is.
 */
const wrapTools = (tools: AISDKTools | undefined) => {
  if (!tools) return tools;

  const inferName = (tool: AISDKTool, fallback: string) =>
    (tool && (tool.name || tool.toolName || tool.id)) || fallback;

  if (Array.isArray(tools)) {
    return tools.map((tool, idx) => {
      const name = inferName(tool, `tool[${idx}]`);
      return wrapToolExecute(tool, name);
    });
  }

  const wrappedTools: Record<string, AISDKTool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    wrappedTools[key] = wrapToolExecute(tool, key);
  }
  return wrappedTools;
};

/**
 * Checks if a value is an AsyncGenerator.
 * AsyncGenerators are returned by async generator functions (async function* () {})
 * and must be iterated to consume their yielded values.
 */
const isAsyncGenerator = (value: any): value is AsyncGenerator => {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value[Symbol.asyncIterator] === "function" &&
    typeof value.next === "function" &&
    typeof value.return === "function" &&
    typeof value.throw === "function"
  );
};

const wrapToolExecute = (tool: AISDKTool, name: string): AISDKTool => {
  // Only wrap tools that have an execute function (created with tool() helper)
  // AI SDK v3-v6: tool({ description, inputSchema/parameters, execute })
  if (
    tool != null &&
    typeof tool === "object" &&
    "execute" in tool &&
    typeof tool.execute === "function"
  ) {
    // Use Proxy with full transparency to wrap execute without breaking Zod schemas
    // The Proxy must implement all traps to be fully transparent for object iteration
    const originalExecute = tool.execute;
    return new Proxy(tool, {
      get(target, prop) {
        if (prop === "execute") {
          // Return a function that handles both regular async functions and async generators
          const wrappedExecute = (...args: unknown[]) => {
            const result = originalExecute.apply(target, args);

            // Check if the result is an async generator (from async function* () {})
            // AI SDK v5 supports async generator tools that yield intermediate status updates
            if (isAsyncGenerator(result)) {
              // Return a wrapper async generator that:
              // 1. Iterates through the original generator
              // 2. Yields all intermediate values (so consumers see status updates)
              // 3. Tracks and logs the final yielded value as the tool output
              return (async function* () {
                const span = startSpan({
                  name,
                  spanAttributes: {
                    type: SpanTypeAttribute.TOOL,
                  },
                });
                span.log({ input: args.length === 1 ? args[0] : args });

                try {
                  let lastValue: unknown;
                  for await (const value of result) {
                    lastValue = value;
                    yield value;
                  }
                  // Log the final yielded value as the output
                  span.log({ output: lastValue });
                } catch (error) {
                  span.log({ error: serializeError(error) });
                  throw error;
                } finally {
                  span.end();
                }
              })();
            }

            // For regular async functions, use traced as before
            return traced(
              async (span) => {
                span.log({ input: args.length === 1 ? args[0] : args });
                const awaitedResult = await result;
                span.log({ output: awaitedResult });
                return awaitedResult;
              },
              {
                name,
                spanAttributes: {
                  type: SpanTypeAttribute.TOOL,
                },
              },
            );
          };
          return wrappedExecute;
        }
        return target[prop];
      },
      // Implement additional traps for full transparency
      has(target, prop) {
        return prop in target;
      },
      ownKeys(target) {
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        return Object.getOwnPropertyDescriptor(target, prop);
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
      deleteProperty(target, prop) {
        delete target[prop];
        return true;
      },
      defineProperty(target, prop, descriptor) {
        Object.defineProperty(target, prop, descriptor);
        return true;
      },
      getPrototypeOf(target) {
        return Object.getPrototypeOf(target);
      },
      setPrototypeOf(target, proto) {
        Object.setPrototypeOf(target, proto);
        return true;
      },
      isExtensible(target) {
        return Object.isExtensible(target);
      },
      preventExtensions(target) {
        Object.preventExtensions(target);
        return true;
      },
    });
  }
  // Pass through tools without execute (e.g., RSC tools with only render, raw definitions)
  return tool;
};

const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {}
  }

  return String(error);
};

/**
 * Parses a gateway model string like "openai/gpt-5-mini" into provider and model.
 * Returns { provider, model } if parseable, otherwise { model } only.
 */
function parseGatewayModelString(modelString: string): {
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
function serializeModelWithProvider(model: AISDKModel | undefined): {
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

  const parsed = parseGatewayModelString(modelId);
  return {
    model: parsed.model,
    provider: explicitProvider || parsed.provider,
  };
}

/**
 * Extracts gateway routing info from the result's providerMetadata.
 * This provides the actual resolved provider and model used by the gateway.
 */
function extractGatewayRoutingInfo(result: AISDKResult): {
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
interface ProcessInputSyncResult {
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
const processInputAttachmentsSync = (
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

/**
 * Async version of processInputAttachments for non-stream wrappers.
 * For v5: responseFormat is a plain object - captured fully
 * For v6: responseFormat is a Promise - awaited and captured fully
 */
const processInputAttachments = async (
  input: AISDKCallParams,
): Promise<AISDKCallParams> => {
  if (!input) return input;

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

  // Process output schema for generateText/streamText with Output.object()
  // The output field contains an Output object with a responseFormat property
  // v5: { type: "json", schema: {...JSON Schema...} } - sync
  // v6: Promise<{ type: "json", schema: {...JSON Schema...} }> - await it
  if (input.output && isOutputObject(input.output)) {
    const serialized = serializeOutputObject(input.output, input.model);

    // v6: If response_format is a Promise, await it
    if (
      serialized.response_format &&
      typeof serialized.response_format.then === "function"
    ) {
      serialized.response_format = await serialized.response_format;
    }

    processed.output = serialized;
  }

  // Remove prepareCall function from logs (not serializable and not useful)
  if (
    "prepareCall" in processed &&
    typeof processed.prepareCall === "function"
  ) {
    processed.prepareCall = "[Function]";
  }

  return processed;
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
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
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
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
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
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Error converting data to attachment:", error);
  }

  return null;
};

const extractGetterValues = (
  obj: AISDKResult,
): Partial<Record<string, unknown>> => {
  // Extract common getter values from AI SDK result objects
  // These are typically on the prototype and not enumerable
  const getterValues: Record<string, unknown> = {};

  // List of known getters from AI SDK result objects
  const getterNames = [
    "text",
    "object",
    "finishReason",
    "usage",
    "toolCalls",
    "toolResults",
    "warnings",
    "experimental_providerMetadata",
    "rawResponse",
    "response",
  ];

  for (const name of getterNames) {
    try {
      if (obj && name in obj && typeof obj[name] !== "function") {
        getterValues[name] = obj[name];
      }
    } catch {
      // Ignore errors accessing getters
    }
  }

  return getterValues;
};

const processOutput = async (
  output: AISDKResult,
  denyOutputPaths?: string[],
) => {
  // Extract getter values before processing
  const getterValues = extractGetterValues(output);

  // Process attachments
  const processed = await processOutputAttachments(output);

  // Merge getter values into the processed output
  const merged = { ...processed, ...getterValues };

  // Apply omit to the merged result to ensure paths are omitted
  return normalizeAISDKLoggedOutput(
    omit(merged, denyOutputPaths ?? DENY_OUTPUT_PATHS),
  );
};

const processOutputAttachments = async (output: AISDKResult) => {
  try {
    return await doProcessOutputAttachments(output);
  } catch (error) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.error("Error processing output attachments:", error);
    return output;
  }
};

const doProcessOutputAttachments = async (output: AISDKResult) => {
  if (!output || !("files" in output)) {
    return output;
  }

  if (output.files && typeof output.files.then === "function") {
    return {
      ...output,
      files: output.files.then(async (files: AISDKGeneratedFile[]) => {
        if (!files || !Array.isArray(files) || files.length === 0) {
          return files;
        }
        return files.map(convertFileToAttachment);
      }),
    };
  } else if (
    output.files &&
    Array.isArray(output.files) &&
    output.files.length > 0
  ) {
    return {
      ...output,
      files: output.files.map(convertFileToAttachment),
    };
  }

  return output;
};

const convertFileToAttachment = (
  file: { mediaType?: string; base64?: string; uint8Array?: Uint8Array },
  index: number,
):
  | Attachment
  | {
      mediaType?: string;
      base64?: string;
      uint8Array?: Uint8Array;
    } => {
  try {
    const mediaType = file.mediaType || "application/octet-stream";
    const filename = `generated_file_${index}.${getExtensionFromMediaType(mediaType)}`;

    let blob: Blob | null = null;

    if (file.base64) {
      blob = convertDataToBlob(file.base64, mediaType);
    } else if (file.uint8Array) {
      blob = new Blob([file.uint8Array], { type: mediaType });
    }

    if (!blob) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.warn(`Failed to convert file at index ${index} to Blob`);
      return file; // Return original if conversion fails
    }

    return new Attachment({
      data: blob,
      filename: filename,
      contentType: mediaType,
    });
  } catch (error) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(`Error processing file at index ${index}:`, error);
    return file; // Return original on error
  }
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
