/**
 * Body serialization: convert wire bytes ↔ `BodyPayload` discriminated union.
 *
 * Encoding strategy is auto-detected by `content-type`:
 *
 * - empty body            → `{ kind: 'empty' }`
 * - `text/event-stream`   → `{ kind: 'sse', chunks: [...] }`  (split on `\n\n`)
 * - `application/json`    → `{ kind: 'json', value: <parsed> }`  (JSON.parse, falls back to text on parse failure)
 * - any `text/*` or XML/JS → `{ kind: 'text', value: <utf-8> }`
 * - large binary (≥ threshold) → `{ kind: 'binary', ... }` via `encodeBinaryDraft` or inline sha256
 * - everything else        → `{ kind: 'base64', value: <b64>, contentType }`
 *
 * Decoding produces wire bytes ready to send. JSON is re-stringified with
 * `JSON.stringify` (no special whitespace) — consumers that hash bodies should
 * be aware that JSON whitespace is not byte-preserved.
 */

import { createHash } from "node:crypto";
import type { BinaryDraft, BodyPayload } from "../cassette";
import type { CassetteStore } from "../store";

const utf8Decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/**
 * Decode `bytes` as text using the charset declared in `contentType` (e.g.
 * `"text/html; charset=iso-8859-1"`). Falls back silently to UTF-8 when the
 * charset is absent, unrecognized, or unsupported by the runtime.
 */
function decodeBytesAsText(bytes: Uint8Array, contentType: string): string {
  const charset = extractCharset(contentType);
  if (!charset || charset === "utf-8" || charset === "utf8") {
    return utf8Decoder.decode(bytes);
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return utf8Decoder.decode(bytes);
  }
}

function extractCharset(contentType: string): string | undefined {
  const match = /;\s*charset\s*=\s*([^\s;]+)/i.exec(contentType);
  return match?.[1]?.toLowerCase();
}

/** SHA-256 hex digest of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Encode raw bytes into a `BodyPayload`.
 *
 * When `threshold` is provided (and not `false`), binary bodies whose byte
 * length meets or exceeds the threshold are encoded as
 * `{ kind: 'binary', path: '', sha256 }` — a sentinel-path form used for
 * matching during replay. The empty `path` is never persisted to disk.
 */
export function encodeBody(
  bytes: Uint8Array,
  contentType: string | undefined,
  threshold?: number | false,
): BodyPayload {
  if (bytes.length === 0) return { kind: "empty" };

  const ct = (contentType ?? "").toLowerCase();

  if (ct.startsWith("text/event-stream")) {
    const text = decodeBytesAsText(bytes, contentType ?? "");
    return { kind: "sse", chunks: splitSseChunks(text) };
  }

  if (isJsonContentType(ct)) {
    const text = decodeBytesAsText(bytes, contentType ?? "");
    try {
      const value: unknown = JSON.parse(text);
      return { kind: "json", value };
    } catch {
      // Server claimed JSON but body wasn't valid; preserve as text rather
      // than failing to record. Better to store something the user can
      // inspect than to drop the response.
      return { kind: "text", value: text };
    }
  }

  if (isTextContentType(ct)) {
    return { kind: "text", value: decodeBytesAsText(bytes, contentType ?? "") };
  }

  // Binary — check threshold before falling back to inline base64.
  if (
    threshold !== undefined &&
    threshold !== false &&
    bytes.length >= threshold
  ) {
    const body: BodyPayload = {
      kind: "binary",
      path: "",
      sha256: sha256Hex(bytes),
    };
    if (contentType) body.contentType = contentType;
    return body;
  }

  const base64Body: BodyPayload = {
    kind: "base64",
    value: encodeBase64(bytes),
  };
  if (contentType) base64Body.contentType = contentType;
  return base64Body;
}

/**
 * Produce a `BinaryDraft` for a large binary body during recording.
 *
 * The draft holds the raw bytes so the recorder can persist them via
 * `store.saveBlob` at `stop()`. Unlike `encodeBody`, this retains the bytes
 * rather than discarding them after hashing.
 */
export function encodeBinaryDraft(
  bytes: Uint8Array,
  contentType: string | undefined,
): BinaryDraft {
  const draft: BinaryDraft = {
    kind: "binary-draft",
    bytes,
    sha256: sha256Hex(bytes),
  };
  if (contentType) draft.contentType = contentType;
  return draft;
}

/**
 * Decode a `BodyPayload` back into wire bytes.
 *
 * For `binary` payloads, `ctx` must provide the store and cassette name so the
 * blob can be loaded. If `ctx` is omitted for a `binary` payload, an error is
 * thrown.
 */
export async function decodeBody(
  body: BodyPayload,
  ctx?: { store: CassetteStore; name: string },
): Promise<Uint8Array> {
  switch (body.kind) {
    case "empty":
      return new Uint8Array();
    case "json":
      return encoder.encode(JSON.stringify(body.value));
    case "text":
      return encoder.encode(body.value);
    case "sse":
      return encoder.encode(joinSseChunks(body.chunks));
    case "base64":
      return decodeBase64(body.value);
    case "binary": {
      if (!ctx?.store.loadBlob) {
        throw new Error(
          "Cannot decode a binary body: the store does not implement loadBlob. " +
            "Use a store that supports external blobs (e.g. createJsonFileStore or createMemoryStore).",
        );
      }
      return ctx.store.loadBlob(ctx.name, body.path);
    }
  }
}

/** True if the content-type indicates a JSON body. */
export function isJsonContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return lower.startsWith("application/json") || /\+json(\s|;|$)/.test(lower);
}

/** True if the content-type indicates a text-encodable body. */
export function isTextContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  if (lower.startsWith("text/")) return true;
  if (lower.startsWith("application/xml")) return true;
  if (lower.startsWith("application/javascript")) return true;
  if (lower.startsWith("application/x-www-form-urlencoded")) return true;
  if (/\+xml(\s|;|$)/.test(lower)) return true;
  return false;
}

// ---- SSE ---------------------------------------------------------------

/**
 * Split a server-sent-events stream into per-event chunks.
 *
 * Events are separated by blank lines (`\n\n`). Each returned chunk is one
 * event without its terminating blank line.
 */
export function splitSseChunks(text: string): string[] {
  // Normalize CRLF separators to LF for splitting; SSE spec allows both.
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  // Drop a trailing empty chunk produced when the stream ends with `\n\n`.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Join SSE chunks back into a single byte stream, with a terminator after each. */
export function joinSseChunks(chunks: string[]): string {
  return chunks.map((c) => `${c}\n\n`).join("");
}

// ---- base64 ------------------------------------------------------------

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
