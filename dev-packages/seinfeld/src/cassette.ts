/**
 * Core cassette types.
 *
 * A cassette captures a series of HTTP request/response pairs that can be
 * replayed later. The data structures here are pure and serializable — they
 * carry no behavior, so they round-trip cleanly through the file store.
 */

/**
 * Body discriminated union. Different `kind` values map to different on-disk
 * encodings.
 *
 * Note: `value` on the `json` variant is typed as optional because `unknown`
 * includes `undefined`. In practice a JSON body always has a serialized value
 * (even if that value is `null`). The optional `?` exists only for type
 * compatibility with zod's `z.unknown()` output.
 */
export type BodyPayload =
  | { kind: "empty" }
  | { kind: "json"; value?: unknown }
  | { kind: "text"; value: string }
  | { kind: "base64"; value: string; contentType?: string }
  | { kind: "sse"; chunks: string[] }
  | { kind: "binary"; path: string; contentType?: string; sha256: string };

/**
 * Transient type produced during recording when a body exceeds the external
 * blob threshold. Holds the raw bytes until `stop()` flushes them via the
 * store. Never serialized to disk — the schema does not know about this kind.
 */
export type BinaryDraft = {
  kind: "binary-draft";
  bytes: Uint8Array;
  sha256: string;
  contentType?: string;
};

/** A single recorded request, as it appeared on the wire. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: BodyPayload;
}

/** A single recorded response, as it appeared on the wire. */
export interface RecordedResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: BodyPayload;
}

/** A normalized request representation used internally for matching. */
export interface NormalizedRequest extends RecordedRequest {
  /** Match key derived from the normalized request (METHOD host/path). */
  matchKey: string;
}

/** One entry in a cassette: a request/response pair plus matching metadata. */
export interface CassetteEntry {
  /** Stable hash-based ID, derived from the normalized request. Useful for diffs. */
  id: string;
  /** The match key (METHOD host/path) used by the default matcher. */
  matchKey: string;
  /** 0-based counter for repeated calls to the same match key. */
  callIndex: number;
  /** ISO-8601 timestamp recorded for human reference; not used for matching. */
  recordedAt: string;
  request: RecordedRequest;
  response: RecordedResponse;
}

/** Optional metadata attached to a cassette file. */
export interface CassetteMeta {
  /** ISO-8601 timestamp when the cassette was first created. */
  createdAt: string;
  /** The seinfeld version that produced the cassette. */
  seinfeldVersion: string;
}

/**
 * The full cassette file shape.
 *
 * The `version` field is required and stamps the on-disk format. Increment it
 * (and add a migration in src/format/migrate.ts) when the schema changes
 * incompatibly.
 */
export interface CassetteFile {
  version: 1;
  meta?: CassetteMeta;
  entries: CassetteEntry[];
}

/** @deprecated Use `CassetteFile` instead. */
export type Cassette = CassetteFile;

/** The three execution modes. See README for full semantics. */
export type CassetteMode = "replay" | "record" | "passthrough";
