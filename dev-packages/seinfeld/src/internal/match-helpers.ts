/**
 * Shared utilities used by both the normalizer (matching pipeline) and the
 * redactor (persistence pipeline). Keeping them here prevents the two
 * subsystems from drifting apart.
 */

/**
 * Return `true` if `name` (a header name) matches any pattern in `patterns`.
 * Comparison is case-insensitive for string patterns; RegExps are tested as-is.
 */
export function headerNameMatches(
  name: string,
  patterns: Array<string | RegExp>,
): boolean {
  const lower = name.toLowerCase();
  return patterns.some((p) =>
    typeof p === "string" ? p.toLowerCase() === lower : p.test(name),
  );
}

/**
 * Return `true` if `path` (a dot-separated JSON field path, e.g. `"a.b.0"`)
 * matches any pattern in `patterns`.
 *
 * Supported pattern forms:
 * - `string`: exact equality.
 * - `RegExp`: tested against the full dot-path string. Note that RegExp
 *   patterns are substring tests by default — anchor with `^...$` to match
 *   the full path.
 * - Wildcard segments: string patterns may contain `*` (match any single
 *   segment) or `**` (match any number of segments, including zero). For
 *   example, `"messages.*.id"` matches `"messages.0.id"` and
 *   `"messages.99.id"`. `"a.**.z"` matches `"a.z"`, `"a.b.z"`, `"a.b.c.z"`.
 */
export function pathMatches(
  path: string,
  patterns: Array<string | RegExp>,
): boolean {
  return patterns.some((p) => {
    if (typeof p === "string") return wildcardPathMatch(path, p);
    return p.test(path);
  });
}

/**
 * Match a dot-separated `path` against a dot-separated `pattern` that may
 * contain `*` (single-segment wildcard) and `**` (multi-segment wildcard).
 */
function wildcardPathMatch(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) return path === pattern;

  const pathSegs = path.split(".");
  const patSegs = pattern.split(".");
  return matchSegments(pathSegs, 0, patSegs, 0);
}

function matchSegments(
  path: string[],
  pi: number,
  pat: string[],
  qi: number,
): boolean {
  while (qi < pat.length) {
    const seg = pat[qi];
    if (seg === "**") {
      // Try matching zero or more path segments.
      for (let skip = 0; skip <= path.length - pi; skip++) {
        if (matchSegments(path, pi + skip, pat, qi + 1)) return true;
      }
      return false;
    }
    if (pi >= path.length) return false;
    if (seg !== "*" && seg !== path[pi]) return false;
    pi++;
    qi++;
  }
  return pi === path.length;
}

/**
 * Remove query parameters matching any pattern from `url`. String patterns
 * match parameter names exactly; RegExp patterns are tested against the name.
 */
export function stripQueryParams(
  url: string,
  patterns: Array<string | RegExp>,
): string {
  const parsed = new URL(url);
  const toDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (
      patterns.some((p) => (typeof p === "string" ? p === key : p.test(key)))
    ) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    parsed.searchParams.delete(key);
  }
  return parsed.toString();
}
