import type {
  BodyPayload,
  CassetteEntry,
  RecordedRequest,
  RecordedResponse,
} from "../cassette";
import { CassetteRedactionError } from "../errors";
import {
  headerNameMatches,
  pathMatches,
  stripQueryParams,
} from "../internal/match-helpers";
import type { RecordedRequestOrDraft, RecordedResponseOrDraft } from "../msw";
import { resolveRedactors } from "./presets";

/**
 * Sentinel value used to replace redacted header values and body fields. Query
 * parameters listed in `redactQueryParams` are deleted entirely from the URL
 * (since `?key=[REDACTED]` would change URL semantics for downstream parsers).
 */
export const REDACTED_SENTINEL = "[REDACTED]";

/**
 * Declarative redaction configuration. Unlike `FilterConfig` (used for
 * matching), `RedactionConfig` transforms what gets persisted to disk.
 *
 * All fields are optional. Default behavior (no spec, or `false`) is to
 * persist real bytes — see README's redaction section for the security
 * implications.
 */
export interface RedactionConfig {
  /** Headers whose values get masked with the sentinel. Case-insensitive on names. */
  redactHeaders?: Array<string | RegExp>;
  /**
   * JSON body field paths whose values get masked with the sentinel.
   *
   * Applies to `json` bodies and to `text` / `sse` bodies whose content parses
   * as JSON (e.g., a server that sends JSON with `Content-Type: text/plain`).
   */
  redactBodyFields?: Array<string | RegExp>;
  /** Query parameter names to delete from the URL entirely. */
  redactQueryParams?: Array<string | RegExp>;
  /**
   * Regex-based text redaction applied to `text` and `sse` bodies after JSON
   * field masking. Each entry may be a plain `RegExp` (replacement defaults to
   * `[REDACTED]`) or an object with a custom `replacement` string.
   *
   * Use this for credentials that appear in plain text, XML, URL-encoded
   * forms, or in SSE event lines that are not JSON.
   */
  redactBodyText?: Array<RegExp | { pattern: RegExp; replacement?: string }>;
  /** Custom request transform run after declarative redaction. */
  redactRequest?: (req: RecordedRequest) => RecordedRequest;
  /** Custom response transform run after declarative redaction. */
  redactResponse?: (res: RecordedResponse) => RecordedResponse;
  /**
   * When `true`, every declarative rule in `redactHeaders` and
   * `redactBodyFields` must match at least one occurrence across the cassette's
   * entries, or `persistIfRecord` throws `CassetteRedactionError`. Unmatched
   * rules almost always indicate a typo in a path or header name.
   *
   * Off by default for backward compatibility. Recommended for any config that
   * redacts known-sensitive fields.
   */
  strict?: boolean;
}

/** Built-in preset names. See `presets.ts` for definitions. */
export type RedactionPreset = "aggressive" | "paranoid";

/**
 * Anything you can pass to `redact:`. `false` disables redaction explicitly
 * (useful for overriding a manager-level default). `undefined` is equivalent
 * to `false`.
 */
export type RedactionSpec =
  | false
  | RedactionPreset
  | RedactionConfig
  | Array<RedactionPreset | RedactionConfig>;

/**
 * Apply a redaction spec to a request. Pure — does not mutate the input.
 *
 * Accepts `RecordedRequestOrDraft` so callers in `record` mode do not need to
 * cast. Binary-draft bodies pass through unchanged (redaction only acts on
 * JSON, text, and sse bodies).
 */
export function applyRequestRedaction(
  req: RecordedRequest | RecordedRequestOrDraft,
  spec: RedactionSpec | undefined,
): RecordedRequest {
  const configs = resolveRedactors(spec);
  let current = req as RecordedRequest;
  for (const config of configs) {
    current = applyRequestRedactionConfig(current, config);
  }
  return current;
}

/**
 * Apply a redaction spec to a response. Pure — does not mutate the input.
 *
 * Accepts `RecordedResponseOrDraft` so callers in `record` mode do not need to
 * cast. Binary-draft bodies pass through unchanged.
 */
export function applyResponseRedaction(
  res: RecordedResponse | RecordedResponseOrDraft,
  spec: RedactionSpec | undefined,
): RecordedResponse {
  const configs = resolveRedactors(spec);
  let current = res as RecordedResponse;
  for (const config of configs) {
    current = applyResponseRedactionConfig(current, config);
  }
  return current;
}

/**
 * Strict-mode check: verify that every declarative rule in the given configs
 * (those with `strict: true`) matched at least one field in the provided
 * entries. Call this after all entries have been flushed in `record` mode.
 *
 * Throws `CassetteRedactionError` listing any patterns that matched nothing.
 *
 * Note: `redactQueryParams` is excluded because deleted params are
 * undetectable after the fact; `redactBodyText` is excluded because text
 * replacements may use non-sentinel replacement strings.
 */
export function checkStrictRedaction(
  cassetteName: string,
  entries: CassetteEntry[],
  configs: RedactionConfig[],
): void {
  const unmatched: string[] = [];

  for (const config of configs) {
    if (!config.strict) continue;

    for (const pattern of config.redactHeaders ?? []) {
      const matched = entries.some(
        (e) =>
          headerWasRedacted(e.request.headers, pattern) ||
          headerWasRedacted(e.response.headers, pattern),
      );
      if (!matched) unmatched.push(`redactHeaders: ${String(pattern)}`);
    }

    for (const pattern of config.redactBodyFields ?? []) {
      const matched = entries.some(
        (e) =>
          bodyFieldWasRedacted(e.request.body, pattern) ||
          bodyFieldWasRedacted(e.response.body, pattern),
      );
      if (!matched) unmatched.push(`redactBodyFields: ${String(pattern)}`);
    }
  }

  if (unmatched.length > 0) {
    throw new CassetteRedactionError({
      cassetteName,
      unmatchedPatterns: unmatched,
    });
  }
}

// ---- Per-config apply helpers -----------------------------------------------

function applyRequestRedactionConfig(
  req: RecordedRequest,
  config: RedactionConfig,
): RecordedRequest {
  let result: RecordedRequest = req;

  if (config.redactHeaders && config.redactHeaders.length > 0) {
    result = {
      ...result,
      headers: maskHeaders(result.headers, config.redactHeaders),
    };
  }

  if (config.redactQueryParams && config.redactQueryParams.length > 0) {
    result = {
      ...result,
      url: stripQueryParams(result.url, config.redactQueryParams),
    };
  }

  if (config.redactBodyFields && config.redactBodyFields.length > 0) {
    result = {
      ...result,
      body: maskBody(result.body, config.redactBodyFields),
    };
  }

  if (config.redactBodyText && config.redactBodyText.length > 0) {
    result = {
      ...result,
      body: applyBodyTextRules(result.body, config.redactBodyText),
    };
  }

  if (config.redactRequest) {
    result = config.redactRequest(result);
  }

  return result;
}

function applyResponseRedactionConfig(
  res: RecordedResponse,
  config: RedactionConfig,
): RecordedResponse {
  let result: RecordedResponse = res;

  if (config.redactHeaders && config.redactHeaders.length > 0) {
    result = {
      ...result,
      headers: maskHeaders(result.headers, config.redactHeaders),
    };
  }

  if (config.redactBodyFields && config.redactBodyFields.length > 0) {
    result = {
      ...result,
      body: maskBody(result.body, config.redactBodyFields),
    };
  }

  if (config.redactBodyText && config.redactBodyText.length > 0) {
    result = {
      ...result,
      body: applyBodyTextRules(result.body, config.redactBodyText),
    };
  }

  if (config.redactResponse) {
    result = config.redactResponse(result);
  }

  return result;
}

// ---- Body masking -----------------------------------------------------------

/**
 * Apply JSON-field masking to a body payload.
 *
 * - `json`: masks fields directly.
 * - `text`: attempts JSON.parse; masks if successful, leaves as-is otherwise.
 * - `sse`: for each chunk, parses `data:` lines as JSON and masks if parseable.
 * - Other kinds pass through unchanged.
 */
function maskBody(
  body: BodyPayload,
  patterns: Array<string | RegExp>,
): BodyPayload {
  if (body.kind === "json") {
    return { kind: "json", value: maskBodyFields(body.value, patterns) };
  }

  if (body.kind === "text") {
    try {
      const parsed: unknown = JSON.parse(body.value);
      return {
        kind: "text",
        value: JSON.stringify(maskBodyFields(parsed, patterns)),
      };
    } catch {
      return body;
    }
  }

  if (body.kind === "sse") {
    const newChunks = body.chunks.map((chunk) =>
      maskSseChunkBodyFields(chunk, patterns),
    );
    return { kind: "sse", chunks: newChunks };
  }

  return body;
}

function maskSseChunkBodyFields(
  chunk: string,
  patterns: Array<string | RegExp>,
): string {
  return chunk
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const prefixLen = line.match(/^data:\s*/)?.[0].length ?? 5;
      const prefix = line.slice(0, prefixLen);
      const data = line.slice(prefixLen);
      try {
        const parsed: unknown = JSON.parse(data);
        return `${prefix}${JSON.stringify(maskBodyFields(parsed, patterns))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

// ---- Text-pattern redaction -------------------------------------------------

function applyBodyTextRules(
  body: BodyPayload,
  rules: NonNullable<RedactionConfig["redactBodyText"]>,
): BodyPayload {
  if (body.kind === "text") {
    return { kind: "text", value: applyTextPatterns(body.value, rules) };
  }

  if (body.kind === "sse") {
    return {
      kind: "sse",
      chunks: body.chunks.map((c) => applyTextPatterns(c, rules)),
    };
  }

  return body;
}

function applyTextPatterns(
  text: string,
  rules: NonNullable<RedactionConfig["redactBodyText"]>,
): string {
  let result = text;
  for (const rule of rules) {
    const regex = rule instanceof RegExp ? rule : rule.pattern;
    const replacement =
      rule instanceof RegExp
        ? REDACTED_SENTINEL
        : (rule.replacement ?? REDACTED_SENTINEL);
    result = result.replace(regex, replacement);
  }
  return result;
}

// ---- Strict-mode helpers ---------------------------------------------------

function headerWasRedacted(
  headers: Record<string, string>,
  pattern: string | RegExp,
): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (value === REDACTED_SENTINEL && headerNameMatches(name, [pattern]))
      return true;
  }
  return false;
}

function bodyFieldWasRedacted(
  body: BodyPayload,
  pattern: string | RegExp,
): boolean {
  if (body.kind === "json") {
    return bodyFieldHasSentinel(body.value, pattern);
  }
  if (body.kind === "text") {
    try {
      return bodyFieldHasSentinel(JSON.parse(body.value), pattern);
    } catch {
      return false;
    }
  }
  if (body.kind === "sse") {
    return body.chunks.some((chunk) =>
      chunk.split("\n").some((line) => {
        if (!line.startsWith("data:")) return false;
        const data = line.slice(line.indexOf(":") + 1).trim();
        try {
          return bodyFieldHasSentinel(JSON.parse(data), pattern);
        } catch {
          return false;
        }
      }),
    );
  }
  return false;
}

function bodyFieldHasSentinel(
  value: unknown,
  pattern: string | RegExp,
  pathSegs: string[] = [],
): boolean {
  if (value === REDACTED_SENTINEL) {
    return pathSegs.length > 0 && pathMatches(pathSegs.join("."), [pattern]);
  }
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((v, i) => {
      pathSegs.push(String(i));
      const found = bodyFieldHasSentinel(v, pattern, pathSegs);
      pathSegs.pop();
      return found;
    });
  }
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => {
    pathSegs.push(k);
    const found = bodyFieldHasSentinel(v, pattern, pathSegs);
    pathSegs.pop();
    return found;
  });
}

// ---- Low-level body helpers ------------------------------------------------

function maskHeaders(
  headers: Record<string, string>,
  patterns: Array<string | RegExp>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k] = headerNameMatches(k, patterns) ? REDACTED_SENTINEL : v;
  }
  return result;
}

function maskBodyFields(
  value: unknown,
  patterns: Array<string | RegExp>,
  pathSegs: string[] = [],
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      pathSegs.push(String(i));
      const result = maskBodyFields(v, patterns, pathSegs);
      pathSegs.pop();
      return result;
    });
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    pathSegs.push(k);
    const dotPath = pathSegs.join(".");
    result[k] = pathMatches(dotPath, patterns)
      ? REDACTED_SENTINEL
      : maskBodyFields(v, patterns, pathSegs);
    pathSegs.pop();
  }
  return result;
}

export { resolveRedactors } from "./presets";
