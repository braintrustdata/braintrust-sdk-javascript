import type { RecordedRequest } from "../cassette";
import type { RecordedRequestOrDraft } from "../msw";
import {
  headerNameMatches,
  pathMatches,
  stripQueryParams,
} from "../internal/match-helpers";
import { resolveFilters } from "./presets";

/**
 * Declarative filter configuration. All fields are optional. Multiple configs
 * can be composed via `FilterSpec`.
 *
 * Filters apply ONLY to the request used for matching — the persisted cassette
 * entry retains the original, unfiltered request bytes. See README's
 * "two-pipeline" section for why this distinction matters.
 */
export interface FilterConfig {
  /**
   * Request headers (matched case-insensitively against header names) to drop
   * before computing the match key. Strings match exactly (case-insensitive);
   * RegExps match against the original header name.
   */
  ignoreHeaders?: Array<string | RegExp>;
  /**
   * JSON body field paths to drop before matching. Paths use dot notation:
   * `"metadata.requestId"`, `"messages.0.id"`. Strings support `*` (any single
   * segment) and `**` (any depth) wildcards, e.g. `"messages.*.id"`. RegExps
   * test against the full dot-path string.
   */
  ignoreBodyFields?: Array<string | RegExp>;
  /**
   * URL query parameter names (exact match for strings, regex test for
   * RegExps) to drop from the URL before matching.
   */
  ignoreQueryParams?: Array<string | RegExp>;
  /**
   * Escape hatch. Receives the request after declarative filters have been
   * applied; returns a possibly-modified request. Runs after the declarative
   * fields above, within a single FilterConfig.
   */
  normalizeRequest?: (req: RecordedRequest) => RecordedRequest;
}

/** Built-in preset names. See `presets.ts` for definitions. */
export type FilterPreset = "default" | "minimal" | "none";

/**
 * Anything you can pass to `filters:`. A preset name, a config object, or an
 * array combining both. Configs are applied in order.
 */
export type FilterSpec =
  | FilterPreset
  | FilterConfig
  | Array<FilterPreset | FilterConfig>;

/**
 * Apply a filter spec to a request. Pure function — does not mutate the input.
 *
 * Accepts `RecordedRequestOrDraft` so callers in `record` mode do not need to
 * cast. Binary-draft bodies pass through unchanged (filters only act on JSON).
 */
export function applyFilters(
  req: RecordedRequest | RecordedRequestOrDraft,
  spec: FilterSpec | undefined,
): RecordedRequest {
  const configs = resolveFilters(spec);
  let current = req as RecordedRequest;
  for (const config of configs) {
    current = applyFilterConfig(current, config);
  }
  return current;
}

function applyFilterConfig(
  req: RecordedRequest,
  config: FilterConfig,
): RecordedRequest {
  let result: RecordedRequest = req;

  if (config.ignoreHeaders && config.ignoreHeaders.length > 0) {
    result = {
      ...result,
      headers: stripHeaders(result.headers, config.ignoreHeaders),
    };
  }

  if (config.ignoreQueryParams && config.ignoreQueryParams.length > 0) {
    result = {
      ...result,
      url: stripQueryParams(result.url, config.ignoreQueryParams),
    };
  }

  if (
    config.ignoreBodyFields &&
    config.ignoreBodyFields.length > 0 &&
    result.body.kind === "json"
  ) {
    const filteredValue = stripBodyFields(
      result.body.value,
      config.ignoreBodyFields,
    );
    result = { ...result, body: { kind: "json", value: filteredValue } };
  }

  if (config.normalizeRequest) {
    result = config.normalizeRequest(result);
  }

  return result;
}

// ---- helpers -------------------------------------------------------------

function stripHeaders(
  headers: Record<string, string>,
  patterns: Array<string | RegExp>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!headerNameMatches(k, patterns)) {
      result[k] = v;
    }
  }
  return result;
}

function stripBodyFields(
  value: unknown,
  patterns: Array<string | RegExp>,
  pathSegs: string[] = [],
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      pathSegs.push(String(i));
      const result = stripBodyFields(v, patterns, pathSegs);
      pathSegs.pop();
      return result;
    });
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    pathSegs.push(k);
    const dotPath = pathSegs.join(".");
    if (pathMatches(dotPath, patterns)) {
      pathSegs.pop();
      continue;
    }
    result[k] = stripBodyFields(v, patterns, pathSegs);
    pathSegs.pop();
  }
  return result;
}

export { resolveFilters } from "./presets";
