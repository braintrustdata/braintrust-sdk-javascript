import { isObject } from "../util/index";

// Internal fallback used for streaming calls: wrappers can stash cached-hit info
// on the stream/result object so instrumentation can still emit `metrics.cached`
// when OpenAI usage data does not include it.
export const BRAINTRUST_CACHED_STREAM_METRIC = "__braintrust_cached_metric";

const LEGACY_CACHED_HEADER = "x-cached";
const X_CACHED_HEADER = "x-bt-cached";

/**
 * Token name mappings for OpenAI metrics.
 */
const TOKEN_NAME_MAP: Record<string, string> = {
  input_tokens: "prompt_tokens",
  output_tokens: "completion_tokens",
  total_tokens: "tokens",
};

/**
 * Token prefix mappings for OpenAI metrics.
 */
const TOKEN_PREFIX_MAP: Record<string, string> = {
  input: "prompt",
  output: "completion",
};

/**
 * Parse metrics from OpenAI usage object.
 * Handles both legacy token names (prompt_tokens, completion_tokens)
 * and newer API token names (input_tokens, output_tokens).
 * Also handles *_tokens_details fields like input_tokens_details.cached_tokens.
 */
export function parseMetricsFromUsage(usage: unknown): Record<string, number> {
  if (!usage) {
    return {};
  }

  const metrics: Record<string, number> = {};

  for (const [oaiName, value] of Object.entries(usage)) {
    if (typeof value === "number") {
      const metricName = TOKEN_NAME_MAP[oaiName] || oaiName;
      metrics[metricName] = value;
      continue;
    }

    if (!oaiName.endsWith("_tokens_details") || !isObject(value)) {
      continue;
    }

    const rawPrefix = oaiName.slice(0, -"_tokens_details".length);
    const prefix = TOKEN_PREFIX_MAP[rawPrefix] || rawPrefix;

    for (const [key, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue !== "number") {
        continue;
      }
      metrics[`${prefix}_${key}`] = nestedValue;
    }
  }

  return metrics;
}

function parseCachedHeader(
  value: string | null | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  return ["true", "hit"].includes(value.toLowerCase()) ? 1 : 0;
}

export function getCachedMetricFromHeaders(
  headers: Headers | null | undefined,
): number | undefined {
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }

  const cachedHeader = headers.get(X_CACHED_HEADER);
  if (cachedHeader) {
    return parseCachedHeader(cachedHeader);
  }

  return parseCachedHeader(headers.get(LEGACY_CACHED_HEADER));
}
