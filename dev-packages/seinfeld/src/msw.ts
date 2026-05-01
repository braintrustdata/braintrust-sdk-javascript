import { HttpResponse, bypass, http, passthrough } from "msw";
import type {
  BinaryDraft,
  BodyPayload,
  RecordedRequest,
  RecordedResponse,
} from "./cassette";
import type { CassetteStore } from "./store";
import { decodeBody, encodeBinaryDraft, encodeBody } from "./serializer";

/**
 * MSW-specific glue. The recorder owns the `setupServer` lifecycle; this
 * module just provides the request/response conversion utilities and the
 * catch-all handler factory.
 */

/** Body type that may carry a `BinaryDraft` in place of a resolved `BodyPayload`. */
export type BodyOrDraft = BodyPayload | BinaryDraft;

/** A `RecordedRequest` whose body may be a transient `BinaryDraft`. */
export type RecordedRequestOrDraft = Omit<RecordedRequest, "body"> & {
  body: BodyOrDraft;
};

/** A `RecordedResponse` whose body may be a transient `BinaryDraft`. */
export type RecordedResponseOrDraft = Omit<RecordedResponse, "body"> & {
  body: BodyOrDraft;
};

/**
 * Convert an MSW `Request` (Fetch API) to a `RecordedRequest`.
 *
 * When `threshold` is provided, binary bodies that meet or exceed it are
 * encoded as `{ kind: 'binary', path: '', sha256 }` for matching purposes.
 * This form is only used in replay mode — it is never persisted.
 */
export async function recordRequest(
  request: Request,
  threshold?: number | false,
): Promise<RecordedRequest> {
  const headers = headersToRecord(request.headers);
  const contentType = request.headers.get("content-type") ?? undefined;

  let bodyBytes: Uint8Array;
  if (request.method === "GET" || request.method === "HEAD") {
    bodyBytes = new Uint8Array();
  } else {
    bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
  }

  return {
    method: request.method,
    url: request.url,
    headers,
    body: encodeBody(bodyBytes, contentType, threshold),
  };
}

/**
 * Convert an MSW `Request` to a `RecordedRequestOrDraft` for record mode.
 *
 * When bytes meet the threshold, the body is a `BinaryDraft` holding the raw
 * bytes so they can be flushed to the store at `stop()`.
 */
export async function recordRequestDraft(
  request: Request,
  threshold: number | false,
): Promise<RecordedRequestOrDraft> {
  const headers = headersToRecord(request.headers);
  const contentType = request.headers.get("content-type") ?? undefined;

  let bodyBytes: Uint8Array;
  if (request.method === "GET" || request.method === "HEAD") {
    bodyBytes = new Uint8Array();
  } else {
    bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
  }

  const body: BodyOrDraft =
    threshold !== false && bodyBytes.length >= threshold
      ? encodeBinaryDraft(bodyBytes, contentType)
      : encodeBody(bodyBytes, contentType);

  return { method: request.method, url: request.url, headers, body };
}

/** Convert a Fetch `Response` to a `RecordedResponse`. */
export async function recordResponse(
  response: Response,
): Promise<RecordedResponse> {
  const headers = headersToRecord(response.headers);
  const contentType = response.headers.get("content-type") ?? undefined;
  const bodyBytes = new Uint8Array(await response.clone().arrayBuffer());

  const recorded: RecordedResponse = {
    status: response.status,
    headers,
    body: encodeBody(bodyBytes, contentType),
  };
  if (response.statusText) recorded.statusText = response.statusText;
  return recorded;
}

/**
 * Convert a Fetch `Response` to a `RecordedResponseOrDraft` for record mode.
 *
 * When bytes meet the threshold, the body is a `BinaryDraft`.
 */
export async function recordResponseDraft(
  response: Response,
  threshold: number | false,
): Promise<RecordedResponseOrDraft> {
  const headers = headersToRecord(response.headers);
  const contentType = response.headers.get("content-type") ?? undefined;
  const bodyBytes = new Uint8Array(await response.clone().arrayBuffer());

  const body: BodyOrDraft =
    threshold !== false && bodyBytes.length >= threshold
      ? encodeBinaryDraft(bodyBytes, contentType)
      : encodeBody(bodyBytes, contentType);

  const result: RecordedResponseOrDraft = {
    status: response.status,
    headers,
    body,
  };
  if (response.statusText) result.statusText = response.statusText;
  return result;
}

/** Build a Fetch `Response` from a `RecordedResponse` for replaying. */
export async function buildResponse(
  recorded: RecordedResponse,
  ctx?: { store: CassetteStore; name: string },
): Promise<Response> {
  const bytes = await decodeBody(recorded.body, ctx);
  // Expand \n-joined set-cookie back into multiple header entries.
  const headers = expandSetCookieHeader(recorded.headers);
  const init: ResponseInit = { status: recorded.status, headers };
  if (recorded.statusText) init.statusText = recorded.statusText;
  // 1xx/204/304 responses must not have a body, per Fetch spec.
  const noBody = bytes.length === 0 || isNullBodyStatus(recorded.status);
  if (noBody) return new Response(null, init);
  // Copy into a fresh ArrayBuffer. (TS 5.7 typed Uint8Array as
  // Uint8Array<ArrayBufferLike>, and `.buffer` may be `SharedArrayBuffer` —
  // neither satisfies the DOM lib's strict ArrayBuffer-only BodyInit.)
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Response(buffer, init);
}

/**
 * Return a `[string, string][]` header list from a `Record<string, string>`,
 * splitting any `\n`-delimited `set-cookie` value back into separate entries.
 */
function expandSetCookieHeader(
  headers: Record<string, string>,
): [string, string][] {
  const result: [string, string][] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie" && value.includes("\n")) {
      for (const cookie of value.split("\n")) {
        result.push([name, cookie]);
      }
    } else {
      result.push([name, value]);
    }
  }
  return result;
}

function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  // set-cookie is special: the Fetch API / undici split multiple Set-Cookie
  // headers but forEach may combine them. Use getSetCookie() (Node 18+) when
  // available to capture all values, stored as a \n-delimited string so that
  // buildResponse can split them back.
  const setCookies = (
    headers as Headers & { getSetCookie?(): string[] }
  ).getSetCookie?.();
  if (setCookies && setCookies.length > 1) {
    result["set-cookie"] = setCookies.join("\n");
  }
  return result;
}

/** Re-exports of the MSW primitives the recorder needs. */
export { HttpResponse, bypass, http, passthrough };
