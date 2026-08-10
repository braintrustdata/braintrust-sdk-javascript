/**
 * Shared utility for Anthropic token calculations.
 *
 * Anthropic's token counting doesn't include cache tokens in total tokens and we need to do the math ourselves.
 */

export interface AnthropicTokenMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cached_tokens?: number;
  prompt_cache_creation_tokens?: number;
  prompt_cache_creation_5m_tokens?: number;
  prompt_cache_creation_1h_tokens?: number;
  tokens?: number;
  [key: string]: number | undefined;
}

/**
 * Rolls cache tokens back into `prompt_tokens`/`tokens` and reduces the
 * cache-creation metrics to a single representation.
 *
 * Callers MUST use the returned object rather than `Object.assign`-ing it back
 * over the input: when a per-TTL breakdown is present this drops the aggregate
 * `prompt_cache_creation_tokens`, and a merge back over the input would keep
 * both representations on the span.
 */
export function finalizeAnthropicTokens(
  metrics: AnthropicTokenMetrics,
): AnthropicTokenMetrics {
  const hasSplitCacheCreationTokens =
    metrics.prompt_cache_creation_5m_tokens !== undefined ||
    metrics.prompt_cache_creation_1h_tokens !== undefined;
  const splitCacheCreationTokens =
    (metrics.prompt_cache_creation_5m_tokens || 0) +
    (metrics.prompt_cache_creation_1h_tokens || 0);
  // The split is an alternative representation of the aggregate, not extra
  // tokens, and only one of the two is emitted — so `prompt_tokens` is sized
  // from whichever representation the span will carry.
  const effectiveCacheCreationTokens = hasSplitCacheCreationTokens
    ? splitCacheCreationTokens
    : metrics.prompt_cache_creation_tokens || 0;
  const prompt_tokens =
    (metrics.prompt_tokens || 0) +
    (metrics.prompt_cached_tokens || 0) +
    effectiveCacheCreationTokens;

  const finalized = {
    ...metrics,
    prompt_tokens,
    tokens: prompt_tokens + (metrics.completion_tokens || 0),
  };
  // Anthropic spans must carry exactly one cache-creation representation, and
  // the per-TTL breakdown wins whenever the provider reported it.
  if (hasSplitCacheCreationTokens) {
    delete finalized.prompt_cache_creation_tokens;
  }
  return finalized;
}

/** Drops unset metrics so the result can be logged as span metrics. */
export function toNumericMetrics(
  metrics: AnthropicTokenMetrics,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(metrics).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );
}

export function extractAnthropicCacheTokens(
  cacheReadTokens: number = 0,
  cacheCreationTokens: number = 0,
): Partial<AnthropicTokenMetrics> {
  const cacheTokens: Partial<AnthropicTokenMetrics> = {};

  if (cacheReadTokens > 0) {
    cacheTokens.prompt_cached_tokens = cacheReadTokens;
  }

  if (cacheCreationTokens > 0) {
    cacheTokens.prompt_cache_creation_tokens = cacheCreationTokens;
  }

  return cacheTokens;
}
