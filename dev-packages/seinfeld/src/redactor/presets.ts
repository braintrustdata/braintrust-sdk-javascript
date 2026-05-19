import type { RedactionConfig, RedactionPreset, RedactionSpec } from "./index";
import { AUTH_HEADERS } from "../internal/well-known-headers";

const CREDENTIAL_HEADERS = AUTH_HEADERS;

/**
 * The "aggressive" redaction preset.
 *
 * Masks common credential headers in both requests and responses. Does not
 * touch body fields — those are too provider-specific to default. Combine with
 * a granular `redactBodyFields` config when you need API-specific masking.
 *
 * @see `'paranoid'` for a preset that also covers body-field and text patterns.
 */
const AGGRESSIVE_REDACTION: RedactionConfig = {
  redactHeaders: CREDENTIAL_HEADERS,
};

/**
 * The "paranoid" redaction preset.
 *
 * A superset of `'aggressive'` that additionally:
 * - Masks common credential field names at any depth in JSON bodies (including
 *   `text` and `sse` bodies whose content is JSON).
 * - Redacts Bearer tokens and OpenAI-style `sk-` keys anywhere in text bodies.
 *
 * Use this for cassettes committed to version control where the underlying
 * APIs use per-request credentials that could appear in response bodies.
 */
const PARANOID_REDACTION: RedactionConfig = {
  omitRequestHeaders: true,
  redactHeaders: CREDENTIAL_HEADERS,
  redactBodyFields: [
    /^(api_?key|access_?token|refresh_?token|prompt_?cache_?key|token|secret|password|authorization)$/i,
  ],
  redactBodyText: [
    { pattern: /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g },
    { pattern: /sk-[A-Za-z0-9]{20,}/g },
  ],
};

const PRESETS: Record<RedactionPreset, RedactionConfig> = {
  aggressive: AGGRESSIVE_REDACTION,
  paranoid: PARANOID_REDACTION,
};

/**
 * Expand a `RedactionSpec` into a flat array of `RedactionConfig`s.
 *
 * - `undefined` or `false` → empty array (no redaction)
 * - preset name → looks up the preset
 * - config object → wrapped in an array
 * - array → recursively flattened
 */
export function resolveRedactors(
  spec: RedactionSpec | undefined,
): RedactionConfig[] {
  if (spec === undefined || spec === false) return [];
  if (typeof spec === "string") return [PRESETS[spec]];
  if (Array.isArray(spec)) {
    return spec.flatMap((item) =>
      typeof item === "string" ? [PRESETS[item]] : [item],
    );
  }
  return [spec];
}
