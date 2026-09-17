import { isPromiseLike } from "../../../util";
import type { AISDKResult } from "../../vendor-sdk-types/ai-sdk";

function safeFieldRead(obj: unknown, field: string): unknown {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }

  try {
    const value = Reflect.get(obj, field);
    if (isPromiseLike(value)) {
      void Promise.resolve(value).catch(() => {});
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number");
}

function parseGatewayCost(cost: unknown): number | undefined {
  if (typeof cost === "number") {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = Number.parseFloat(cost);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function extractCost(result: AISDKResult): number | undefined {
  const steps = safeFieldRead(result, "steps");
  if (Array.isArray(steps)) {
    let total = 0;
    let found = false;
    for (const step of steps) {
      const providerMetadata = safeFieldRead(step, "providerMetadata");
      const gateway = safeFieldRead(providerMetadata, "gateway");
      const cost =
        parseGatewayCost(safeFieldRead(gateway, "cost")) ??
        parseGatewayCost(safeFieldRead(gateway, "marketCost"));
      if (cost !== undefined && cost > 0) {
        total += cost;
        found = true;
      }
    }
    if (found) {
      return total;
    }
  }

  const providerMetadata = safeFieldRead(result, "providerMetadata");
  const gateway = safeFieldRead(providerMetadata, "gateway");
  const cost =
    parseGatewayCost(safeFieldRead(gateway, "cost")) ??
    parseGatewayCost(safeFieldRead(gateway, "marketCost"));
  return cost !== undefined && cost > 0 ? cost : undefined;
}

/** Normalize token and cost metrics across AI SDK provider interface versions. */
export function extractTokenMetrics(
  result: AISDKResult,
): Record<string, number> {
  const totalUsage = safeFieldRead(result, "totalUsage");
  const usageValue = totalUsage ?? safeFieldRead(result, "usage");
  if (!usageValue || typeof usageValue !== "object") {
    return {};
  }

  const usage = usageValue;
  const inputTokensValue = safeFieldRead(usage, "inputTokens");
  const outputTokensValue = safeFieldRead(usage, "outputTokens");
  const inputTokenDetails = safeFieldRead(usage, "inputTokenDetails");
  const providerMetadata = safeFieldRead(result, "providerMetadata");
  const anthropicMetadata = safeFieldRead(providerMetadata, "anthropic");
  const anthropicUsage = safeFieldRead(anthropicMetadata, "usage");
  const metrics: Record<string, number> = {};

  const promptTokens = firstNumber(
    safeFieldRead(inputTokensValue, "total"),
    inputTokensValue,
    safeFieldRead(usage, "promptTokens"),
    safeFieldRead(usage, "prompt_tokens"),
  );
  const completionTokens = firstNumber(
    safeFieldRead(outputTokensValue, "total"),
    outputTokensValue,
    safeFieldRead(usage, "completionTokens"),
    safeFieldRead(usage, "completion_tokens"),
  );
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }

  const totalTokens = firstNumber(
    safeFieldRead(usage, "totalTokens"),
    safeFieldRead(usage, "tokens"),
    safeFieldRead(usage, "total_tokens"),
  );

  const promptCachedTokens = firstNumber(
    safeFieldRead(inputTokensValue, "cacheRead"),
    safeFieldRead(inputTokenDetails, "cacheReadTokens"),
    safeFieldRead(usage, "cachedInputTokens"),
    safeFieldRead(usage, "promptCachedTokens"),
    safeFieldRead(usage, "prompt_cached_tokens"),
    safeFieldRead(anthropicUsage, "cache_read_input_tokens"),
  );
  if (promptCachedTokens !== undefined) {
    metrics.prompt_cached_tokens = promptCachedTokens;
  }

  const promptCacheCreationTokens = firstNumber(
    safeFieldRead(inputTokensValue, "cacheWrite"),
    safeFieldRead(inputTokenDetails, "cacheWriteTokens"),
    safeFieldRead(usage, "promptCacheCreationTokens"),
    safeFieldRead(usage, "prompt_cache_creation_tokens"),
    safeFieldRead(anthropicMetadata, "cacheCreationInputTokens"),
    safeFieldRead(anthropicUsage, "cache_creation_input_tokens"),
  );
  if (promptCacheCreationTokens !== undefined) {
    metrics.prompt_cache_creation_tokens = promptCacheCreationTokens;
  }

  const anthropicInputTokens = firstNumber(
    safeFieldRead(anthropicUsage, "input_tokens"),
  );
  const cacheTokens =
    (promptCachedTokens ?? 0) + (promptCacheCreationTokens ?? 0);
  const promptTokensExcludeCache =
    cacheTokens > 0 &&
    promptTokens !== undefined &&
    anthropicInputTokens !== undefined &&
    promptTokens === anthropicInputTokens;
  const normalizedPromptTokens =
    promptTokens === undefined
      ? undefined
      : promptTokens + (promptTokensExcludeCache ? cacheTokens : 0);
  if (normalizedPromptTokens !== undefined) {
    metrics.prompt_tokens = normalizedPromptTokens;
  }

  if (totalTokens !== undefined) {
    const totalTokensExcludeCache =
      promptTokensExcludeCache &&
      completionTokens !== undefined &&
      totalTokens === promptTokens + completionTokens;
    metrics.tokens = totalTokens + (totalTokensExcludeCache ? cacheTokens : 0);
  } else if (
    normalizedPromptTokens !== undefined &&
    completionTokens !== undefined
  ) {
    metrics.tokens = normalizedPromptTokens + completionTokens;
  }

  const promptReasoningTokens = firstNumber(
    safeFieldRead(usage, "promptReasoningTokens"),
    safeFieldRead(usage, "prompt_reasoning_tokens"),
  );
  if (promptReasoningTokens !== undefined) {
    metrics.prompt_reasoning_tokens = promptReasoningTokens;
  }

  const completionCachedTokens = firstNumber(
    safeFieldRead(usage, "completionCachedTokens"),
    safeFieldRead(usage, "completion_cached_tokens"),
  );
  if (completionCachedTokens !== undefined) {
    metrics.completion_cached_tokens = completionCachedTokens;
  }

  const reasoningTokens = firstNumber(
    safeFieldRead(outputTokensValue, "reasoning"),
    safeFieldRead(usage, "reasoningTokens"),
    safeFieldRead(usage, "completionReasoningTokens"),
    safeFieldRead(usage, "completion_reasoning_tokens"),
    safeFieldRead(usage, "reasoning_tokens"),
    safeFieldRead(usage, "thinkingTokens"),
    safeFieldRead(usage, "thinking_tokens"),
  );
  if (reasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = reasoningTokens;
    metrics.reasoning_tokens = reasoningTokens;
  }

  const completionAudioTokens = firstNumber(
    safeFieldRead(usage, "completionAudioTokens"),
    safeFieldRead(usage, "completion_audio_tokens"),
  );
  if (completionAudioTokens !== undefined) {
    metrics.completion_audio_tokens = completionAudioTokens;
  }

  const cost = extractCost(result);
  if (cost !== undefined) {
    metrics.estimated_cost = cost;
  }

  return metrics;
}
