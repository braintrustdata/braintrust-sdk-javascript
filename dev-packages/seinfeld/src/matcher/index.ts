import type { CassetteEntry, NormalizedRequest } from "../cassette";

/**
 * A `MatchCandidate` is a cassette entry paired with its filtered request.
 *
 * The recorder pre-applies the active filter spec to each entry's request once
 * at cassette load time and presents the result here. Matchers compare the
 * incoming filtered request against `filtered`, but return `entry` so callers
 * still have access to the original (unfiltered) response.
 */
export interface MatchCandidate {
  entry: CassetteEntry;
  filtered: NormalizedRequest;
}

/**
 * A matcher locates a cassette entry that should respond to a given request.
 *
 * Default: match on method + url + body. Custom matchers can use any criteria
 * they want (loose body comparison, header dependence, ignoring `callIndex`,
 * etc.). Always called with pre-filtered inputs.
 */
export interface Matcher {
  findMatch(
    request: NormalizedRequest,
    candidates: ReadonlyArray<MatchCandidate>,
    callIndex: number,
  ): CassetteEntry | null;
}

/**
 * Compute the canonical match key for a request: `METHOD host/path` (without
 * query string). Used to group cassette entries for efficient lookup.
 */
export function computeMatchKey(method: string, url: string): string {
  const parsed = new URL(url);
  return `${method.toUpperCase()} ${parsed.host}${parsed.pathname}`;
}

/**
 * Promote a `RecordedRequest` to a `NormalizedRequest` by attaching the
 * computed match key. Used by the recorder after applying filters.
 */
export function asNormalized<T extends { method: string; url: string }>(
  req: T,
): T & { matchKey: string } {
  return { ...req, matchKey: computeMatchKey(req.method, req.url) };
}

export { createDefaultMatcher } from "./default";
