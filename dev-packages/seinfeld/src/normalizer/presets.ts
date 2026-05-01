import type { FilterConfig, FilterPreset, FilterSpec } from "./index";
import {
  AUTH_HEADERS,
  FINGERPRINT_HEADERS,
  RATE_LIMIT_HEADERS,
  TRANSPORT_HEADERS,
} from "../internal/well-known-headers";

// Re-export for consumers who want to compose their own presets.
export {
  AUTH_HEADERS,
  TRANSPORT_HEADERS,
  RATE_LIMIT_HEADERS,
  FINGERPRINT_HEADERS,
};

/**
 * Default normalization preset.
 *
 * Strips transport, auth, rate-limit, and fingerprint headers from the request
 * before computing the match key. The match becomes resilient to trivial
 * differences across runs (different auth tokens, different user-agents, new
 * rate-limit response headers, etc.) without altering the persisted cassette.
 */
export const DEFAULT_FILTER: FilterConfig = {
  ignoreHeaders: [
    ...TRANSPORT_HEADERS,
    ...AUTH_HEADERS,
    ...RATE_LIMIT_HEADERS,
    ...FINGERPRINT_HEADERS,
  ],
};

/**
 * Minimal normalization preset. Only strips transport headers.
 */
export const MINIMAL_FILTER: FilterConfig = {
  ignoreHeaders: TRANSPORT_HEADERS,
};

/**
 * No-op normalization preset.
 */
export const NONE_FILTER: FilterConfig = {};

const PRESETS: Record<FilterPreset, FilterConfig> = {
  default: DEFAULT_FILTER,
  minimal: MINIMAL_FILTER,
  none: NONE_FILTER,
};

/**
 * Expand a `FilterSpec` into a flat array of `FilterConfig`s.
 *
 * - `undefined` → empty array
 * - preset name → looks up the preset
 * - config object → wrapped in an array
 * - array → recursively flattened
 */
export function resolveFilters(spec: FilterSpec | undefined): FilterConfig[] {
  if (spec === undefined) return [];
  if (typeof spec === "string") return [PRESETS[spec]];
  if (Array.isArray(spec)) {
    return spec.flatMap((item) =>
      typeof item === "string" ? [PRESETS[item]] : [item],
    );
  }
  return [spec];
}
