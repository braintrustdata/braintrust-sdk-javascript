import type { BodyPayload } from "../cassette";
import type { Matcher } from "./index";

/**
 * The default matcher.
 *
 * Compares filtered requests by method, URL (including query), and body. Among
 * the entries that match structurally, picks the one at position `callIndex`
 * (clamped to the last available entry — so if there are more replay calls
 * than recorded entries, the last one is reused).
 *
 * Headers are not compared by default. Filtering of volatile headers is
 * already handled by the normalizer pipeline.
 */
export function createDefaultMatcher(): Matcher {
  return {
    findMatch(request, candidates, callIndex) {
      const matching = candidates.filter(
        (c) =>
          c.filtered.method === request.method &&
          c.filtered.url === request.url &&
          bodyEqual(c.filtered.body, request.body),
      );

      if (matching.length === 0) return null;

      const picked = matching[Math.min(callIndex, matching.length - 1)];
      return picked ? picked.entry : null;
    },
  };
}

function bodyEqual(a: BodyPayload, b: BodyPayload): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "empty":
      return true;
    case "json": {
      const bv = (b as Extract<BodyPayload, { kind: "json" }>).value;
      return deepEqual(a.value, bv);
    }
    case "text":
      return a.value === (b as Extract<BodyPayload, { kind: "text" }>).value;
    case "base64":
      return a.value === (b as Extract<BodyPayload, { kind: "base64" }>).value;
    case "sse": {
      const bChunks = (b as Extract<BodyPayload, { kind: "sse" }>).chunks;
      if (a.chunks.length !== bChunks.length) return false;
      return a.chunks.every((c, i) => c === bChunks[i]);
    }
    case "binary": {
      // Compare by SHA-256 digest only. The `path` field is not part of
      // equality — it differs between cassette entries (real path) and
      // incoming replay requests (sentinel empty string).
      return (
        a.sha256 === (b as Extract<BodyPayload, { kind: "binary" }>).sha256
      );
    }
  }
}

function deepEqual(a: unknown, b: unknown, seen = new Set<unknown>()): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  // Cycle guard: treat any object pair seen before as unequal.
  if (seen.has(a)) return false;
  seen.add(a);
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) {
    seen.delete(a);
    return false;
  }
  if (aIsArr) {
    const aArr = a as readonly unknown[];
    const bArr = b as readonly unknown[];
    if (aArr.length !== bArr.length) {
      seen.delete(a);
      return false;
    }
    for (let i = 0; i < aArr.length; i++) {
      if (!deepEqual(aArr[i], bArr[i], seen)) {
        seen.delete(a);
        return false;
      }
    }
    seen.delete(a);
    return true;
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) {
    seen.delete(a);
    return false;
  }
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, k)) {
      seen.delete(a);
      return false;
    }
    if (!deepEqual(aRec[k], bRec[k], seen)) {
      seen.delete(a);
      return false;
    }
  }
  seen.delete(a);
  return true;
}
