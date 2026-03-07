import { BasePlugin } from "../core";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { aiSDKChannels } from "./ai-sdk-channels";
import type {
  AISDKCallParams,
  AISDKModel,
  AISDKResult,
  AISDKUsage,
} from "../../vendor-sdk-types/ai-sdk";

export interface AISDKPluginConfig {
  /**
   * List of JSON paths to remove from output field.
   * Uses dot notation with array wildcards: "roundtrips[].request.body"
   */
  denyOutputPaths?: string[];
}

/**
 * Default paths to omit from AI SDK output logging.
 * These contain redundant or verbose data that's not useful for tracing.
 */
const DEFAULT_DENY_OUTPUT_PATHS: string[] = [
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

/**
 * AI SDK plugin that subscribes to instrumentation channels
 * and creates Braintrust spans.
 *
 * This plugin handles:
 * - generateText (async function)
 * - streamText (async function returning stream)
 * - generateObject (async function)
 * - streamObject (async function returning stream)
 * - Agent.generate (async method)
 * - Agent.stream (async method returning stream)
 *
 * The plugin automatically extracts:
 * - Model and provider information
 * - Token usage metrics
 * - Tool calls and structured outputs
 * - Streaming responses with time-to-first-token
 */
export class AISDKPlugin extends BasePlugin<typeof aiSDKChannels> {
  private config: AISDKPluginConfig;

  constructor(config: AISDKPluginConfig = {}) {
    super();
    this.config = config;
  }

  protected onEnable(): void {
    this.subscribeToAISDK();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToAISDK(): void {
    const denyOutputPaths =
      this.config.denyOutputPaths || DEFAULT_DENY_OUTPUT_PATHS;

    // generateText - async function that may return streams
    this.subscribeToStreamingChannel(aiSDKChannels.generateText, {
      name: "generateText",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        return {
          input: processAISDKInput(params),
          metadata: extractMetadataFromParams(params),
        };
      },
      extractOutput: (result) => processAISDKOutput(result, denyOutputPaths),
      extractMetrics: (result, startTime) => {
        const metrics = extractTokenMetrics(result);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        return metrics;
      },
      aggregateChunks: aggregateAISDKChunks,
    });

    // streamText - async function returning stream
    this.subscribeToStreamingChannel(aiSDKChannels.streamText, {
      name: "streamText",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        return {
          input: processAISDKInput(params),
          metadata: extractMetadataFromParams(params),
        };
      },
      extractOutput: (result) => processAISDKOutput(result, denyOutputPaths),
      extractMetrics: (result, startTime) => {
        const metrics = extractTokenMetrics(result);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        return metrics;
      },
      aggregateChunks: aggregateAISDKChunks,
    });

    // generateObject - async function that may return streams
    this.subscribeToStreamingChannel(aiSDKChannels.generateObject, {
      name: "generateObject",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        return {
          input: processAISDKInput(params),
          metadata: extractMetadataFromParams(params),
        };
      },
      extractOutput: (result) => processAISDKOutput(result, denyOutputPaths),
      extractMetrics: (result, startTime) => {
        const metrics = extractTokenMetrics(result);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        return metrics;
      },
      aggregateChunks: aggregateAISDKChunks,
    });

    // streamObject - async function returning stream
    this.subscribeToStreamingChannel(aiSDKChannels.streamObject, {
      name: "streamObject",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        return {
          input: processAISDKInput(params),
          metadata: extractMetadataFromParams(params),
        };
      },
      extractOutput: (result) => processAISDKOutput(result, denyOutputPaths),
      extractMetrics: (result, startTime) => {
        const metrics = extractTokenMetrics(result);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        return metrics;
      },
      aggregateChunks: aggregateAISDKChunks,
    });

    // Agent.generate - async method
    this.subscribeToStreamingChannel(aiSDKChannels.agentGenerate, {
      name: "Agent.generate",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        return {
          input: processAISDKInput(params),
          metadata: extractMetadataFromParams(params),
        };
      },
      extractOutput: (result) => processAISDKOutput(result, denyOutputPaths),
      extractMetrics: (result, startTime) => {
        const metrics = extractTokenMetrics(result);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        return metrics;
      },
      aggregateChunks: aggregateAISDKChunks,
    });

    // Agent.stream - async method returning stream
    this.subscribeToStreamingChannel(aiSDKChannels.agentStream, {
      name: "Agent.stream",
      type: SpanTypeAttribute.LLM,
      extractInput: ([params]) => {
        return {
          input: processAISDKInput(params),
          metadata: extractMetadataFromParams(params),
        };
      },
      extractOutput: (result) => processAISDKOutput(result, denyOutputPaths),
      extractMetrics: (result, startTime) => {
        const metrics = extractTokenMetrics(result);
        if (startTime) {
          metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
        }
        return metrics;
      },
      aggregateChunks: aggregateAISDKChunks,
    });
  }
}

/**
 * Process AI SDK input parameters, converting attachments as needed.
 */
function processAISDKInput(params: AISDKCallParams): unknown {
  if (!params) return params;

  // Use the attachment processing from the manual wrapper
  return processInputAttachments(params);
}

/**
 * Extract metadata from AI SDK parameters.
 * Includes model, provider, and integration info.
 */
function extractMetadataFromParams(
  params: AISDKCallParams,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    braintrust: {
      integration_name: "ai-sdk",
      sdk_language: "typescript",
    },
  };

  // Extract model information
  const { model, provider } = serializeModelWithProvider(params.model);
  if (model) {
    metadata.model = model;
  }
  if (provider) {
    metadata.provider = provider;
  }

  return metadata;
}

/**
 * Process AI SDK output, omitting specified paths.
 */
function processAISDKOutput(
  output: AISDKResult,
  denyOutputPaths: string[],
): Record<string, unknown> | AISDKResult {
  if (!output) return output;

  // Extract getter values from result objects
  const getterValues = extractGetterValues(output);

  // Merge with original output
  const merged = { ...output, ...getterValues };

  // Apply omit to remove unwanted paths
  return omit(merged, denyOutputPaths);
}

/**
 * Extract token metrics from AI SDK result.
 */
function extractTokenMetrics(result: AISDKResult): Record<string, number> {
  const metrics: Record<string, number> = {};

  // Agent results use totalUsage, other results use usage
  let usage: AISDKUsage | undefined = result?.totalUsage || result?.usage;

  // Try as getter if not directly accessible
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

  // Extract token counts
  const promptTokens = firstNumber(
    usage.inputTokens?.total,
    usage.inputTokens,
    usage.promptTokens,
    usage.prompt_tokens,
  );
  if (promptTokens !== undefined) {
    metrics.prompt_tokens = promptTokens;
  }

  const completionTokens = firstNumber(
    usage.outputTokens?.total,
    usage.outputTokens,
    usage.completionTokens,
    usage.completion_tokens,
  );
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }

  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.tokens,
    usage.total_tokens,
  );
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  }

  // Extract cost from gateway routing if available
  const cost = extractCostFromResult(result);
  if (cost !== undefined) {
    metrics.estimated_cost = cost;
  }

  return metrics;
}

/**
 * Aggregate AI SDK streaming chunks into a single response.
 */
function aggregateAISDKChunks(chunks: unknown[]): {
  output: Record<string, unknown>;
  metrics: Record<string, number>;
} {
  // For AI SDK streams, the chunks are typically delta objects
  // We'll return the last chunk which usually contains the final state
  const lastChunk = chunks[chunks.length - 1] as AISDKResult | undefined;

  const output: Record<string, unknown> = {};
  let metrics: Record<string, number> = {};

  // Extract usage from last chunk
  if (lastChunk) {
    metrics = extractTokenMetrics(lastChunk);

    // Extract common output fields
    if (lastChunk.text !== undefined) {
      output.text = lastChunk.text;
    }
    if (lastChunk.object !== undefined) {
      output.object = lastChunk.object;
    }
    if (lastChunk.finishReason !== undefined) {
      output.finishReason = lastChunk.finishReason;
    }
    if (lastChunk.toolCalls !== undefined) {
      output.toolCalls = lastChunk.toolCalls;
    }
  }

  return { output, metrics };
}

/**
 * Extract getter values from AI SDK result objects.
 */
function extractGetterValues(
  obj: AISDKResult,
): Partial<Record<string, unknown>> {
  const getterValues: Record<string, unknown> = {};

  const getterNames = [
    "text",
    "object",
    "finishReason",
    "usage",
    "totalUsage",
    "toolCalls",
    "toolResults",
    "warnings",
    "experimental_providerMetadata",
    "providerMetadata",
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
}

/**
 * Extracts model ID and provider from a model object or string.
 */
function serializeModelWithProvider(model: AISDKModel | undefined): {
  model: string | undefined;
  provider?: string;
} {
  const modelId = typeof model === "string" ? model : model?.modelId;
  const explicitProvider =
    typeof model === "object" ? model?.provider : undefined;

  if (!modelId) {
    return { model: modelId, provider: explicitProvider };
  }

  // Parse gateway-style model strings like "openai/gpt-4"
  const parsed = parseGatewayModelString(modelId);
  return {
    model: parsed.model,
    provider: explicitProvider || parsed.provider,
  };
}

/**
 * Parse gateway model string like "openai/gpt-4" into provider and model.
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
 * Extract cost from result's providerMetadata.
 */
function extractCostFromResult(result: AISDKResult): number | undefined {
  // Check for cost in steps (multi-step results)
  if (result?.steps && Array.isArray(result.steps) && result.steps.length > 0) {
    let totalCost = 0;
    let foundCost = false;
    for (const step of result.steps) {
      const gateway = step?.providerMetadata?.gateway;
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

  // Check direct providerMetadata
  const gateway = result?.providerMetadata?.gateway;
  const directCost =
    parseGatewayCost(gateway?.cost) || parseGatewayCost(gateway?.marketCost);
  if (directCost !== undefined && directCost > 0) {
    return directCost;
  }

  return undefined;
}

/**
 * Parse gateway cost value.
 */
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

/**
 * Get first number from a list of values.
 */
function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number") {
      return v;
    }
  }
  return undefined;
}

/**
 * Deep copy an object via JSON serialization.
 */
function deepCopy(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Parse a JSON path string into an array of keys.
 */
function parsePath(path: string): (string | number)[] {
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
}

/**
 * Omit a value at a specific path in an object.
 */
function omitAtPath(
  obj: Record<string, unknown> | unknown[] | undefined,
  keys: (string | number)[],
): void {
  if (keys.length === 0) return;

  const firstKey = keys[0];
  const remainingKeys = keys.slice(1);

  if (firstKey === "[]") {
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (remainingKeys.length > 0) {
          omitAtPath(
            item as Record<string, unknown> | unknown[] | undefined,
            remainingKeys,
          );
        }
      });
    }
  } else if (remainingKeys.length === 0) {
    if (obj && typeof obj === "object" && firstKey in obj) {
      (obj as Record<string | number, unknown>)[firstKey] = "<omitted>";
    }
  } else {
    if (obj && typeof obj === "object" && firstKey in obj) {
      omitAtPath(
        (obj as Record<string | number, unknown>)[firstKey] as
          | Record<string, unknown>
          | unknown[]
          | undefined,
        remainingKeys,
      );
    }
  }
}

/**
 * Omit specified paths from an object.
 */
function omit(
  obj: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  const result = deepCopy(obj);

  for (const path of paths) {
    const keys = parsePath(path);
    omitAtPath(result, keys);
  }

  return result;
}
