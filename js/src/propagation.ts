/**
 * Native W3C Trace Context propagation for Braintrust.
 *
 * This module implements the propagation wire format described in the Braintrust
 * distributed-tracing spec, in pure TypeScript with no dependency on
 * `@opentelemetry/api`. It parses and serializes the W3C `traceparent` and
 * `baggage` headers and the Braintrust `braintrust.parent` baggage entry.
 *
 * Trace identity (trace id + parent span id) is carried in `traceparent`; the
 * Braintrust container the trace belongs to (project/experiment) is carried in
 * `baggage` under the `braintrust.parent` key.
 */

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";
export const BAGGAGE_HEADER = "baggage";
export const BRAINTRUST_PARENT_KEY = "braintrust.parent";

// Trace-flags byte we emit for traces we originate: sampled (low bit set).
const DEFAULT_TRACE_FLAGS = "01";

/**
 * Parsed W3C `traceparent` fields.
 *
 * `traceFlags` is the raw 2-hex trace-flags byte (e.g. `"01"` sampled, `"00"`
 * not sampled), kept raw so any future flag bits survive a parse -> format
 * round trip without per-bit handling.
 */
export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  traceFlags: string;
}

/**
 * Inbound W3C trace-context state that Braintrust forwards but never interprets.
 *
 * Captured at the span created from inbound headers (via
 * `extractTraceContextFromHeaders`) and inherited by every subspan, so that any
 * `inject()` within the trace re-emits the upstream state unchanged, per the W3C
 * Trace Context spec.
 *
 * - `tracestate`: the W3C `tracestate` header (opaque vendor state).
 * - `traceFlags`: the raw 2-hex `traceparent` trace-flags byte. Stored raw so
 *   future flag bits are preserved without per-bit handling.
 */
export interface PropagatedState {
  tracestate?: string;
  traceFlags?: string;
}

type TraceContextHeaderValue =
  | string
  | number
  | readonly string[]
  | null
  | undefined;

export type TraceContextHeaderTuple = readonly [name: string, value: string];

/**
 * Minimal structural interface for inbound HTTP headers.
 *
 * Covers Node/framework header bags and Web/Fetch-compatible `Headers` objects
 * without depending on Node or DOM platform typings.
 */
export type TraceContextHeaders =
  | { [name: string]: TraceContextHeaderValue }
  | { get(name: string): TraceContextHeaderValue }
  | { getHeader(name: string): TraceContextHeaderValue }
  | readonly TraceContextHeaderTuple[];

/**
 * Minimal structural interface for outbound HTTP header carriers.
 *
 * Supports plain objects, Web/Fetch-compatible `Headers`, Node/Fastify-style
 * response carriers, and mutable `HeadersInit` tuple arrays.
 */
export type TraceContextCarrier =
  | { [name: string]: TraceContextHeaderValue }
  | {
      get(name: string): TraceContextHeaderValue;
      set(name: string, value: string): void;
      delete?(name: string): void;
    }
  | {
      getHeader(name: string): TraceContextHeaderValue;
      setHeader(name: string, value: string): void;
      removeHeader?(name: string): void;
    }
  | {
      get?(name: string): TraceContextHeaderValue;
      getHeader?(name: string): TraceContextHeaderValue;
      header(name: string, value: string): void;
      delete?(name: string): void;
      removeHeader?(name: string): void;
    }
  | [string, string][];

// W3C traceparent: version-traceid-parentid-flags, version 00, lowercase hex.
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

// W3C Baggage limits (§3.3.2): a conformant baggage-string must satisfy *both*
// of these conditions. https://www.w3.org/TR/baggage/#limits
//   - Condition 1: at most 64 list-members.
//   - Condition 2: at most 8192 bytes total.
//
// We reuse these as a defensive bound on parsing/relaying untrusted inbound
// headers: the header arrives from the network and is attacker-controllable, so
// we never split or decode an unbounded string. When an inbound header exceeds
// either limit we drop trailing list-members rather than truncate one mid-value:
// the spec says a platform that cannot propagate all list-members "MUST NOT
// propagate any partial list-members", so we keep only the leading whole members
// that fit within both limits.
const MAX_BAGGAGE_LENGTH = 8192;
const MAX_BAGGAGE_MEMBERS = 64;

// W3C Trace Context §3.3.1.5 limits tracestate to 32 list-members and 512
// characters total. The grammar is ASCII-only, so character count and byte count
// are equivalent after validation.
const MAX_TRACESTATE_LENGTH = 512;
const MAX_TRACESTATE_MEMBERS = 32;

const _utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return _utf8Encoder.encode(value).length;
}

/**
 * Return `value` bounded to the W3C limits, never splitting a list-member
 * mid-value.
 *
 * Enforces both §3.3.2 limits: at most `MAX_BAGGAGE_MEMBERS` list-members and at
 * most `MAX_BAGGAGE_LENGTH` UTF-8 bytes (the spec limit is a byte count, not
 * code points). If the header is within both limits it is returned unchanged.
 * Otherwise we keep the leading whole members that fit and drop the rest -- a
 * trailing member that would be partial is never kept. If even the first member
 * exceeds the byte limit there is no complete member to keep, so we return an
 * empty string.
 */
function capBaggageToMemberBoundary(value: string): string {
  const totalBytes = utf8ByteLength(value);
  const withinBytes = totalBytes <= MAX_BAGGAGE_LENGTH;
  // Cheap structural cap on member count: actual members are <= comma count + 1.
  let commaCount = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 0x2c) {
      commaCount++;
    }
  }
  const withinMembers = commaCount < MAX_BAGGAGE_MEMBERS;
  if (withinBytes && withinMembers) {
    return value;
  }

  // Walk members in order, keeping whole ones until either limit is reached. We
  // account on UTF-8 byte length so the byte budget is exact, and we only ever
  // cut on comma boundaries so partial code points are never split.
  const kept: string[] = [];
  let length = 0;
  for (const rawMember of value.split(",")) {
    if (kept.length >= MAX_BAGGAGE_MEMBERS) {
      break;
    }
    const cost = utf8ByteLength(rawMember) + (kept.length ? 1 : 0);
    if (length + cost > MAX_BAGGAGE_LENGTH) {
      break;
    }
    kept.push(rawMember);
    length += cost;
  }
  if (!kept.length) {
    // The first member alone already exceeds the byte limit.
    return "";
  }
  return kept.join(",");
}

/**
 * Normalize a raw header value to a single string.
 *
 * Node's `IncomingHttpHeaders` and some frameworks expose multi-valued headers
 * as a string array; the W3C trace-context headers are single-valued, so we take
 * the first element. Returns undefined for missing/empty values.
 */
function isTraceContextHeaderTupleArray(
  value: unknown,
): value is readonly TraceContextHeaderTuple[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        Array.isArray(item) &&
        typeof item[0] === "string" &&
        typeof item[1] === "string",
    )
  );
}

function isListHeader(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered === BAGGAGE_HEADER || lowered === TRACESTATE_HEADER;
}

function headerValueToString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const stringValues = value.filter((item): item is string => {
      return typeof item === "string";
    });
    if (!stringValues.length) {
      return undefined;
    }
    return isListHeader(name) ? stringValues.join(",") : stringValues[0];
  }
  return typeof value === "string" ? value : String(value);
}

export function isValidTracestate(value: string | undefined | null): boolean {
  if (!value || value.length > MAX_TRACESTATE_LENGTH) {
    return false;
  }

  const members = value.split(",");
  if (members.length > MAX_TRACESTATE_MEMBERS) {
    return false;
  }

  const seenKeys = new Set<string>();
  for (const rawMember of members) {
    const member = rawMember.trim();
    const eq = member.indexOf("=");
    if (eq <= 0 || member.indexOf("=", eq + 1) !== -1) {
      return false;
    }

    const key = member.slice(0, eq);
    const valuePart = member.slice(eq + 1);
    const keyIsValid =
      /^[a-z][a-z0-9_\-*/]{0,255}$/.test(key) ||
      /^[a-z][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13}$/.test(key);
    if (
      !keyIsValid ||
      seenKeys.has(key) ||
      valuePart.length === 0 ||
      valuePart.length > 256 ||
      valuePart.charCodeAt(valuePart.length - 1) === 0x20
    ) {
      return false;
    }
    seenKeys.add(key);

    for (let i = 0; i < valuePart.length; i++) {
      const c = valuePart.charCodeAt(i);
      const valid =
        c === 0x20 ||
        c === 0x21 ||
        (c >= 0x23 && c <= 0x2b) ||
        (c >= 0x2d && c <= 0x3c) ||
        (c >= 0x3e && c <= 0x7e);
      if (!valid) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Case-insensitive header lookup.
 *
 * Some frameworks normalize header names to title case (e.g. `Traceparent`)
 * while the W3C keys are lowercase; Web `Headers` objects expose a
 * case-insensitive `.get(name)` method. Returns the first matching value or
 * undefined. Array-valued `baggage` and `tracestate` headers are comma-joined;
 * other array-valued headers are reduced to their first element.
 */
export function getHeader(
  headers: TraceContextHeaders | TraceContextCarrier | null | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (isTraceContextHeaderTupleArray(headers)) {
    const lowered = name.toLowerCase();
    const matches = headers
      .filter(([key]) => key.toLowerCase() === lowered)
      .map(([, value]) => value);
    if (!matches.length) {
      return undefined;
    }
    return headerValueToString(matches, name);
  }

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    try {
      const value = headerValueToString(getter.call(headers, name), name);
      if (value !== undefined) {
        return value;
      }
    } catch {
      // Fall back to other lookup styles for custom header-like objects.
    }
  }

  const nodeGetter = (headers as { getHeader?: unknown }).getHeader;
  if (typeof nodeGetter === "function") {
    try {
      const value = headerValueToString(nodeGetter.call(headers, name), name);
      if (value !== undefined) {
        return value;
      }
    } catch {
      // Fall back to object lookup for custom header-like objects.
    }
  }

  const headerBag = headers as { [name: string]: TraceContextHeaderValue };
  // Fast path: exact (lowercase) match.
  const exact = headerValueToString(headerBag[name], name);
  if (exact !== undefined) {
    return exact;
  }
  const lowered = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key !== name && key.toLowerCase() === lowered) {
      const value = headerValueToString(headerBag[key], name);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function isHex(value: string | undefined | null, length: number): boolean {
  if (typeof value !== "string" || value.length !== length) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const isDigit = c >= "0" && c <= "9";
    const isLowerHex = c >= "a" && c <= "f";
    if (!isDigit && !isLowerHex) {
      return false;
    }
  }
  return true;
}

/**
 * Parse a W3C `traceparent` value into a {@link ParsedTraceparent}.
 *
 * Returns `{ traceId, spanId, traceFlags }`, where `traceFlags` is the raw
 * 2-hex trace-flags byte. Returns undefined for any malformed value (bad
 * version, wrong length, non-hex, or all-zero ids). Never throws.
 */
export function parseTraceparent(
  value: string | undefined | null,
): ParsedTraceparent | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const traceId = match[1];
  const spanId = match[2];
  const traceFlags = match[3];
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return undefined;
  }
  return { traceId, spanId, traceFlags };
}

/**
 * Serialize a W3C `traceparent` value from hex trace/span ids.
 *
 * `traceFlags` is the raw 2-hex trace-flags byte to emit; it is forwarded
 * verbatim so any upstream/future flag bits survive. Falls back to
 * `DEFAULT_TRACE_FLAGS` (sampled) when not a valid 2-hex byte. Returns undefined
 * if the ids are not valid W3C-shaped hex (so callers can omit the header rather
 * than emit something malformed).
 */
export function formatTraceparent(
  traceId: string | undefined | null,
  spanId: string | undefined | null,
  traceFlags: string = DEFAULT_TRACE_FLAGS,
): string | undefined {
  if (!isHex(traceId, 32) || traceId === ZERO_TRACE_ID) {
    return undefined;
  }
  if (!isHex(spanId, 16) || spanId === ZERO_SPAN_ID) {
    return undefined;
  }
  const flags = isHex(traceFlags, 2) ? traceFlags : DEFAULT_TRACE_FLAGS;
  return `00-${traceId}-${spanId}-${flags}`;
}

// Per W3C Baggage (§3.3.1.3), a value's unencoded bytes are restricted to the
// `baggage-octet` set:
//
//   baggage-octet = %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
//
// i.e. US-ASCII excluding CTLs, whitespace, DQUOTE, comma, semicolon, and
// backslash; the percent sign MUST be encoded; and any non-ASCII code point MUST
// be percent-encoded (as UTF-8 octets). We only ever encode our own
// `braintrust.parent` member, whose value embeds an arbitrary, user-controlled
// project/experiment name -- so it can contain any of those characters.
//
// `encodeURIComponent` percent-encodes every byte outside the set
// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. Every char it leaves unencoded is within
// `baggage-octet`, so the result is always spec-compliant: we may over-encode
// some characters that are technically legal unencoded (the spec explicitly
// permits this), but we never emit a byte that violates the grammar. Space is
// emitted as `%20`, not the form-urlencoded `+`.
//
// On receive we decode with `decodeURIComponent`, the inverse of
// `encodeURIComponent` (`%20` -> space, multi-byte UTF-8 reassembled). A literal
// `+` in a value is encoded to `%2B` and decoded back to `+`, so it survives.
//
// Byte-for-byte pass-through of *other* vendors' baggage is handled separately
// by `mergeBaggage`, which forwards their raw member strings unchanged rather
// than round-tripping them through this codec.

function percentEncode(value: string): string {
  return encodeURIComponent(value);
}

function percentDecode(value: string): string {
  if (!value.includes("%")) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a W3C `baggage` header into an ordered map of key -> value.
 *
 * Tolerates malformed/oversized input by skipping bad entries; never throws.
 * Property metadata (after ';') is ignored. Keys and values are percent-decoded.
 */
export function parseBaggage(
  value: string | undefined | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "string") {
    return result;
  }
  // Oversized header: bound the work to whole list-members (never mid-value).
  const bounded = capBaggageToMemberBoundary(value);
  for (let member of bounded.split(",")) {
    member = member.trim();
    if (!member || !member.includes("=")) {
      continue;
    }
    // Strip any ';'-delimited properties.
    member = member.split(";", 1)[0];
    const eq = member.indexOf("=");
    const key = percentDecode(member.slice(0, eq).trim());
    const val = member.slice(eq + 1).trim();
    if (!key) {
      continue;
    }
    result[key] = percentDecode(val);
  }
  return result;
}

/**
 * Merge a `braintrust.parent` value into an existing `baggage` header.
 *
 * This preserves every other vendor's baggage member byte-for-byte: their raw
 * `key=value` substrings (properties included) are forwarded exactly as received
 * rather than decoded and re-encoded. Decoding then re-encoding would silently
 * rewrite another vendor's percent-encoding (e.g. `path=a%2Fb` -> `path=a/b`),
 * so we keep Braintrust a transparent relay. Whitespace around list members is
 * insignificant per W3C and is trimmed.
 *
 * Only the `braintrust.parent` member is (re)serialized, by us, from the
 * `braintrustParent` argument. Any pre-existing `braintrust.parent` member in
 * `existing` is dropped in favor of the supplied value.
 *
 * The result is bounded to both W3C limits (§3.3.2): at most 64 list-members and
 * at most 8192 bytes. Our own `braintrust.parent` member is prioritized when it
 * fits: its byte cost and one member slot are reserved first, then relayed
 * members are appended in order until either budget is exhausted, always on
 * whole-member boundaries (never a partial list-member). Relayed members that do
 * not fit are dropped. If the encoded `braintrust.parent` member is itself too
 * large to fit in a valid baggage header, it is omitted.
 *
 * Returns the merged header value, or undefined if there is nothing to emit (so
 * callers omit the header rather than emit an empty one).
 */
export function mergeBaggage(
  existing: string | undefined | null,
  braintrustParent: string | undefined | null,
): string | undefined {
  let btMember: string | undefined = undefined;
  if (braintrustParent) {
    const encodedKey = percentEncode(BRAINTRUST_PARENT_KEY);
    const encodedVal = percentEncode(String(braintrustParent));
    btMember = `${encodedKey}=${encodedVal}`;
    if (utf8ByteLength(btMember) > MAX_BAGGAGE_LENGTH) {
      btMember = undefined;
    }
  }

  // Reserve both budgets for our own member first when it fits; relayed members
  // fill whatever space remains.
  let byteBudget = MAX_BAGGAGE_LENGTH;
  let memberBudget = MAX_BAGGAGE_MEMBERS;
  if (btMember !== undefined) {
    // +1 for the comma joining our member to any preceding relayed member.
    byteBudget -= utf8ByteLength(btMember) + 1;
    memberBudget -= 1;
  }

  const relayed: string[] = [];
  let length = 0;
  if (existing && typeof existing === "string") {
    for (const rawMember of existing.split(",")) {
      const member = rawMember.trim();
      if (!member || !member.includes("=")) {
        continue;
      }
      // Identify the key (ignoring ';'-delimited properties) only to skip any
      // inbound braintrust.parent; everything else is forwarded raw.
      const keyPart = member.split(";", 1)[0].split("=", 1)[0];
      const key = percentDecode(keyPart.trim());
      if (key === BRAINTRUST_PARENT_KEY) {
        continue;
      }
      // Stop at whole-member boundaries once either budget is exhausted; we
      // never forward a partial member (W3C §3.3.2).
      if (relayed.length >= memberBudget) {
        break;
      }
      const cost = utf8ByteLength(member) + (relayed.length ? 1 : 0);
      if (length + cost > byteBudget) {
        break;
      }
      relayed.push(member);
      length += cost;
    }
  }

  const members = btMember !== undefined ? [...relayed, btMember] : relayed;
  if (!members.length) {
    return undefined;
  }
  return members.join(",");
}
