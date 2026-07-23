/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { SpanTypeAttribute } from "../../../../util/index";
import { startSpan, type CompiledPrompt } from "../../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../../span-origin";
import {
  extractAnthropicCacheTokens,
  finalizeAnthropicTokens,
} from "../../anthropic-tokens-util";
import { processInputAttachments } from "../../attachment-utils";

function detectProviderFromResult(result: {
  providerMetadata?: Record<string, unknown>;
}): string | undefined {
  if (!result?.providerMetadata) {
    return undefined;
  }

  const keys = Object.keys(result.providerMetadata);
  return keys?.at(0);
}

function extractModelFromResult(result: {
  response?: { modelId?: string };
  request?: { body?: { model?: string } };
}): string | undefined {
  if (result?.response?.modelId) {
    return result.response.modelId;
  }

  if (result?.request?.body?.model) {
    return result.request.body.model;
  }

  return undefined;
}

function extractModelFromWrapGenerateCallback(model: {
  modelId?: string;
  config?: Record<string, unknown>;
  specificationVersion?: string;
  provider?: string;
  supportedUrls?: Record<string, unknown>;
}): string | undefined {
  return model?.modelId;
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function extractModelParameters(
  params: Record<string, unknown>,
  excludeKeys: Set<string>,
): Record<string, unknown> {
  const modelParams: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && !excludeKeys.has(key)) {
      const snakeKey = camelToSnake(key);
      modelParams[snakeKey] = value;
    }
  }

  return modelParams;
}

function getNumberProperty(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== "object" || !(key in obj)) {
    return undefined;
  }
  const value = Reflect.get(obj, key);
  return typeof value === "number" ? value : undefined;
}

function normalizeUsageMetrics(
  usage: unknown,
  provider?: string,
  providerMetadata?: Record<string, unknown>,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  // Standard AI SDK usage fields
  const inputTokens = getNumberProperty(usage, "inputTokens");
  if (inputTokens !== undefined) {
    metrics.prompt_tokens = inputTokens;
  }

  const outputTokens = getNumberProperty(usage, "outputTokens");
  if (outputTokens !== undefined) {
    metrics.completion_tokens = outputTokens;
  }

  const totalTokens = getNumberProperty(usage, "totalTokens");
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  }

  const reasoningTokens = getNumberProperty(usage, "reasoningTokens");
  if (reasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = reasoningTokens;
  }

  const cachedInputTokens = getNumberProperty(usage, "cachedInputTokens");
  if (cachedInputTokens !== undefined) {
    metrics.prompt_cached_tokens = cachedInputTokens;
  }

  // Anthropic-specific cache token handling
  if (provider === "anthropic") {
    const anthropicMetadata = providerMetadata?.anthropic as any;

    if (anthropicMetadata) {
      const cacheReadTokens =
        getNumberProperty(anthropicMetadata.usage, "cache_read_input_tokens") ||
        0;
      const cacheCreationTokens =
        getNumberProperty(
          anthropicMetadata.usage,
          "cache_creation_input_tokens",
        ) || 0;

      const cacheTokens = extractAnthropicCacheTokens(
        cacheReadTokens,
        cacheCreationTokens,
      );
      Object.assign(metrics, cacheTokens);

      Object.assign(metrics, finalizeAnthropicTokens(metrics));
    }
  }

  return metrics;
}

function normalizeFinishReason(reason: any): string | undefined {
  if (typeof reason !== "string") return undefined;
  return reason.replace(/-/g, "_");
}

function buildAssistantOutputWithToolCalls(result: any, toolCalls: any[]) {
  return [
    {
      index: 0,
      logprobs: null,
      finish_reason:
        normalizeFinishReason(result?.finishReason) ??
        (toolCalls.length ? "tool_calls" : undefined),
      message: {
        role: "assistant",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
    },
  ];
}

function extractToolCallsFromSteps(steps: any[] | undefined) {
  const toolCalls: any[] = [];
  if (!Array.isArray(steps)) return toolCalls;
  let idx = 0;
  for (const step of steps) {
    const blocks: any[] | undefined = (step as any)?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (
        block &&
        typeof block === "object" &&
        (block as any).type === "tool-call"
      ) {
        toolCalls.push({
          id: (block as any).toolCallId,
          type: "function",
          index: idx++,
          function: {
            name: (block as any).toolName,
            arguments:
              typeof (block as any).input === "string"
                ? (block as any).input
                : JSON.stringify((block as any).input ?? {}),
          },
        });
      }
    }
  }
  return toolCalls;
}

function extractToolCallsFromBlocks(blocks: any[] | undefined) {
  if (!Array.isArray(blocks)) return [];
  return extractToolCallsFromSteps([{ content: blocks }] as any);
}

function extractInput(params: any) {
  return params?.prompt ?? params?.messages ?? params?.system;
}

// Generic middleware interface that works with any AI SDK types
interface LanguageModelV2Middleware<TModel = any, TCallOptions = any> {
  wrapGenerate?: (options: {
    doGenerate: () => any;
    doStream: () => any;
    params: TCallOptions;
    model: TModel;
  }) => Promise<any>;
  wrapStream?: (options: {
    doGenerate: () => any;
    doStream: () => any;
    params: TCallOptions;
    model: TModel;
  }) => Promise<any>;
}

/**
 * Configuration options for the AI SDK middleware
 */
interface MiddlewareConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Name identifier for the middleware instance */
  name?: string;
  /** Span info from loadPrompt for prompt version tracking */
  spanInfo?: CompiledPrompt<"chat">["span_info"];
}

// V2-specific exclude keys for extractModelParameters
const V2_EXCLUDE_KEYS = new Set([
  "prompt", // Already captured as input
  "system", // Already captured as input
  "messages", // Already captured as input
  "model", // Already captured in metadata.model
  "providerOptions", // Internal AI SDK configuration
]);

/**
 * Creates a Braintrust middleware for AI SDK v2 that automatically traces
 * generateText and streamText calls with comprehensive metadata and metrics.
 *
 * @param config - Configuration options for the middleware
 * @returns A middleware object compatible with AI SDK v2's wrapLanguageModel
 *
 * @deprecated The new `wrapAISDK` replaces this middleware.
 *
 * @example
 * ```typescript
 * import { wrapLanguageModel } from "ai";
 * import { openai } from "@ai-sdk/openai";
 * import { BraintrustMiddleware } from "braintrust";
 *
 * const model = wrapLanguageModel({
 *   model: openai("gpt-4"),
 *   middleware: BraintrustMiddleware({ debug: true, name: "MyMiddleware" })
 * });
 * ```
 *
 */
export function BraintrustMiddleware(
  config: MiddlewareConfig = {},
): LanguageModelV2Middleware<any, any> {
  return {
    wrapGenerate: async ({
      doGenerate,
      params,
      model: modelFromWrapGenerate,
    }) => {
      // Extract and process input attachments
      const rawInput = extractInput(params);
      const processedInput = processInputAttachments(rawInput);

      const spanArgs = {
        name: config.spanInfo?.name || "ai-sdk.doGenerate",
        spanAttributes: {
          type: SpanTypeAttribute.LLM,
          ...(config.spanInfo?.spanAttributes || {}),
        },
        event: {
          input: processedInput,
          metadata: {
            ...extractModelParameters(params, V2_EXCLUDE_KEYS),
            ...(config.spanInfo?.metadata || {}),
          },
        },
      };

      const span = startSpan(
        withSpanInstrumentationName(spanArgs, INSTRUMENTATION_NAMES.AI_SDK),
      );

      try {
        const result = await doGenerate();

        const metadata: Record<string, unknown> = {};

        const provider = detectProviderFromResult(result);
        if (provider !== undefined) {
          metadata.provider = provider;
        }

        if (result.finishReason !== undefined) {
          metadata.finish_reason = result.finishReason;
        }

        const model = extractModelFromResult(result);
        if (model !== undefined) {
          metadata.model = model;
        } else if (modelFromWrapGenerate) {
          // Use the model from the wrapGenerate call if it's not in the result
          const modelId = extractModelFromWrapGenerateCallback(
            modelFromWrapGenerate,
          );
          if (modelId) {
            metadata.model = modelId;
          }
        }

        let toolCalls = extractToolCallsFromSteps((result as any)?.steps);
        if (!toolCalls || toolCalls.length === 0) {
          toolCalls = extractToolCallsFromBlocks((result as any)?.content);
        }

        span.log({
          output:
            toolCalls.length > 0
              ? buildAssistantOutputWithToolCalls(result, toolCalls)
              : (result as any)?.content,
          metadata,
          metrics: normalizeUsageMetrics(
            result.usage,
            provider,
            result.providerMetadata,
          ),
        });

        return result;
      } catch (error) {
        span.log({
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
    wrapStream: async ({ doStream, params }) => {
      // Extract and process input attachments
      const rawInput = extractInput(params);
      const processedInput = processInputAttachments(rawInput);

      const spanArgs = {
        name: config.spanInfo?.name || "ai-sdk.doStream",
        spanAttributes: {
          type: SpanTypeAttribute.LLM,
          ...(config.spanInfo?.spanAttributes || {}),
        },
        event: {
          input: processedInput,
          metadata: {
            ...extractModelParameters(params, V2_EXCLUDE_KEYS),
            ...(config.spanInfo?.metadata || {}),
          },
        },
      };

      const span = startSpan(
        withSpanInstrumentationName(spanArgs, INSTRUMENTATION_NAMES.AI_SDK),
      );

      try {
        const { stream, ...rest } = await doStream();

        const textChunks: string[] = [];
        const toolBlocks: any[] = [];
        let finalUsage: unknown = {};
        let finalFinishReason: unknown = undefined;
        let providerMetadata: Record<string, unknown> = {};

        const transformStream = new TransformStream({
          transform(chunk: any, controller: any) {
            try {
              // Collect text deltas
              if (chunk.type === "text-delta" && chunk.delta) {
                textChunks.push(chunk.delta);
              }

              // Collect tool call/result blocks for formatting later
              if (chunk.type === "tool-call" || chunk.type === "tool-result") {
                toolBlocks.push(chunk);
              }

              // Capture final metadata
              if (chunk.type === "finish") {
                finalFinishReason = chunk.finishReason;
                finalUsage = chunk.usage || {};
                providerMetadata = chunk.providerMetadata || {};
              }

              controller.enqueue(chunk);
            } catch (error) {
              // Log stream processing error
              span.log({
                error: error instanceof Error ? error.message : String(error),
              });
              span.end();
              controller.error(error);
            }
          },

          flush() {
            try {
              // Log the final aggregated result when stream completes
              const generatedText = textChunks.join("");
              let output: unknown = generatedText
                ? [{ type: "text", text: generatedText }]
                : [];

              // Create a result object for provider detection
              const resultForDetection = {
                providerMetadata,
                response: rest.response,
                ...rest,
                finishReason: finalFinishReason,
              };

              const metadata: Record<string, unknown> = {};

              const provider = detectProviderFromResult(resultForDetection);
              if (provider !== undefined) {
                metadata.provider = provider;
              }

              if (finalFinishReason !== undefined) {
                metadata.finish_reason = finalFinishReason;
              }

              const model = extractModelFromResult(resultForDetection);
              if (model !== undefined) {
                metadata.model = model;
              }

              // If tool calls streamed, prefer assistant tool_calls output
              if (toolBlocks.length > 0) {
                const toolCalls = extractToolCallsFromSteps([
                  { content: toolBlocks },
                ] as any);
                if (toolCalls.length > 0) {
                  output = buildAssistantOutputWithToolCalls(
                    resultForDetection,
                    toolCalls,
                  );
                }
              }

              span.log({
                output,
                metadata,
                metrics: normalizeUsageMetrics(
                  finalUsage,
                  provider,
                  providerMetadata,
                ),
              });

              span.end();
            } catch (error) {
              // Log flush error
              span.log({
                error: error instanceof Error ? error.message : String(error),
              });
              span.end();
              throw error;
            }
          },
        });

        return {
          stream: stream.pipeThrough(transformStream),
          ...rest,
        };
      } catch (error) {
        span.log({
          error: error instanceof Error ? error.message : String(error),
        });
        span.end();
        throw error;
      }
    },
  };
}
