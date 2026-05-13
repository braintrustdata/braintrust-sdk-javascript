import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
  BodyPayload,
  CassetteFile,
  CassetteEntry,
  CassetteMode,
  RecordedRequest,
} from "./cassette";
import { AggregateCassetteMissError, CassetteMissError } from "./errors";
import { CURRENT_FORMAT_VERSION } from "./format";
import { applyFilters } from "./normalizer";
import type { FilterSpec } from "./normalizer";
import { asNormalized } from "./matcher";
import type { MatchCandidate, Matcher } from "./matcher";
import { createDefaultMatcher } from "./matcher/default";
import { applyRequestRedaction, applyResponseRedaction } from "./redactor";
import type { RedactionSpec } from "./redactor";
import type {
  BodyOrDraft,
  RecordedRequestOrDraft,
  RecordedResponseOrDraft,
} from "./http";
import {
  buildResponse,
  recordRequest,
  recordRequestDraft,
  recordResponseDraft,
} from "./http";
import type { CassetteStore } from "./store";

// Injected at build time by tsup define. Falls back to 'dev' when running
// directly without a build step.
declare const __SEINFELD_VERSION__: string;
const SEINFELD_VERSION: string =
  typeof __SEINFELD_VERSION__ !== "undefined" ? __SEINFELD_VERSION__ : "dev";

const DEFAULT_EXTERNAL_BLOB_THRESHOLD = 65536;

export type IgnoredRequestMatcher = string | RegExp;

// ---- Internal draft types ------------------------------------------------

type CassetteEntryDraft = Omit<CassetteEntry, "request" | "response"> & {
  request: RecordedRequestOrDraft;
  response: RecordedResponseOrDraft;
};

// ---- Per-cassette server context -----------------------------------------

interface CassetteContext {
  // Static config (set at server creation time, never mutated)
  name: string;
  mode: CassetteMode;
  store: CassetteStore;
  matcher: Matcher;
  filters: FilterSpec | undefined;
  redact: RedactionSpec;
  ignoredRequests: IgnoredRequestMatcher[] | undefined;
  threshold: number | false;
  onMiss: ((req: RecordedRequest) => void) | undefined;

  // Per-run mutable state (reset on each start)
  candidates: MatchCandidate[];
  callCounts: Map<string, number>;
  newEntries: CassetteEntryDraft[];
  misses: CassetteMissError[];
}

function isIgnoredRequest(
  url: string,
  ignoredRequests: IgnoredRequestMatcher[] | undefined,
): boolean {
  if (!ignoredRequests || ignoredRequests.length === 0) return false;
  return ignoredRequests.some((matcher) =>
    typeof matcher === "string" ? url === matcher : matcher.test(url),
  );
}

// ---- Per-request handlers -------------------------------------------------

async function handleCassetteRequest(
  ctx: CassetteContext,
  request: Request,
  getRealResponse: () => Promise<Response>,
): Promise<Response> {
  if (isIgnoredRequest(request.url, ctx.ignoredRequests)) {
    return new Response(null, { status: 204 });
  }

  switch (ctx.mode) {
    case "replay": {
      const recorded = await recordRequest(request, ctx.threshold);
      return handleReplay(ctx, recorded);
    }
    case "record": {
      const draft = await recordRequestDraft(request, ctx.threshold);
      return handleRecord(ctx, getRealResponse, draft);
    }
    case "passthrough":
      return getRealResponse();
  }
}

function handleReplay(
  ctx: CassetteContext,
  recorded: RecordedRequest,
): Promise<Response> {
  const filtered = asNormalized(applyFilters(recorded, ctx.filters));
  const matchKey = filtered.matchKey;
  const callIndex = bumpCallCount(ctx, matchKey);

  const sameKey = ctx.candidates.filter(
    (c) => c.filtered.matchKey === matchKey,
  );
  const match = ctx.matcher.findMatch(filtered, sameKey, callIndex);

  if (!match) {
    ctx.onMiss?.(recorded);
    const error = new CassetteMissError({
      request: recorded,
      cassetteName: ctx.name,
      matchKey,
    });
    ctx.misses.push(error);
    return Promise.resolve(
      new Response(JSON.stringify({ error: error.message }), {
        status: 599,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  return buildResponse(match.response, { store: ctx.store, name: ctx.name });
}

async function handleRecord(
  ctx: CassetteContext,
  getRealResponse: () => Promise<Response>,
  recorded: RecordedRequestOrDraft,
): Promise<Response> {
  const realResponse = await getRealResponse();
  const captured: RecordedResponseOrDraft = await recordResponseDraft(
    realResponse,
    ctx.threshold,
  );

  const filtered = asNormalized(applyFilters(recorded, ctx.filters));
  const matchKey = filtered.matchKey;
  const callIndex = bumpCallCount(ctx, matchKey);

  const redactedRequest = applyRequestRedaction(recorded, ctx.redact);
  const redactedResponse = applyResponseRedaction(captured, ctx.redact);

  ctx.newEntries.push({
    id: makeEntryId(filtered.matchKey, callIndex, filtered.body),
    matchKey,
    callIndex,
    recordedAt: new Date().toISOString(),
    request: redactedRequest,
    response: redactedResponse,
  });

  // Return the response to the caller.
  //
  // For non-draft bodies (JSON, text, empty, SSE), build a fresh Response
  // from the already-captured bytes. This avoids a Node.js/undici issue
  // where realResponse.clone() after recordResponseDraft() (which already
  // teed the body stream) can return an empty body, causing callers to
  // misparse the response.
  //
  return buildResponse(captured, {
    store: ctx.store,
    name: ctx.name,
  });
}

// ---- Per-run state helpers -----------------------------------------------

function resetContext(ctx: CassetteContext): void {
  ctx.candidates = [];
  ctx.callCounts.clear();
  ctx.newEntries.length = 0;
  ctx.misses.length = 0;
}

async function loadCandidates(ctx: CassetteContext): Promise<void> {
  const cassette = await ctx.store.load(ctx.name);
  if (!cassette) {
    ctx.candidates = [];
    return;
  }
  ctx.candidates = cassette.entries.map((entry) => {
    const filtered = applyFilters(entry.request, ctx.filters);
    return { entry, filtered: asNormalized(filtered) };
  });
}

async function persistIfRecord(ctx: CassetteContext): Promise<void> {
  if (ctx.mode !== "record") return;
  const flushedEntries = await Promise.all(
    ctx.newEntries.map((e) => flushEntry(e, ctx.store, ctx.name)),
  );
  // Preserve the original createdAt when re-recording an existing cassette.
  let createdAt = new Date().toISOString();
  try {
    const existing = await ctx.store.load(ctx.name);
    if (existing?.meta?.createdAt) createdAt = existing.meta.createdAt;
  } catch {
    // Ignore load errors (corrupt file, version mismatch) — stamp fresh.
  }
  const cassette: CassetteFile = {
    version: CURRENT_FORMAT_VERSION,
    meta: { createdAt, seinfeldVersion: SEINFELD_VERSION },
    entries: flushedEntries,
  };
  await ctx.store.save(ctx.name, cassette);
}

function throwFirstMiss(ctx: CassetteContext): void {
  if (ctx.misses.length > 1) {
    throw new AggregateCassetteMissError([...ctx.misses]);
  }
  const miss = ctx.misses[0];
  if (miss !== undefined) throw miss;
}

function bumpCallCount(ctx: CassetteContext, matchKey: string): number {
  const current = ctx.callCounts.get(matchKey) ?? 0;
  ctx.callCounts.set(matchKey, current + 1);
  return current;
}

// ---- Blob flush helpers --------------------------------------------------

async function flushBody(
  body: BodyOrDraft,
  store: CassetteStore,
  name: string,
): Promise<BodyPayload> {
  if (body.kind !== "binary-draft") return body;
  if (!store.saveBlob) {
    throw new Error(
      "Cannot record external binary blobs: the store does not implement saveBlob. " +
        "Use createJsonFileStore.",
    );
  }
  const path = await store.saveBlob(name, body.bytes);
  const result: BodyPayload = { kind: "binary", path, sha256: body.sha256 };
  if (body.contentType) result.contentType = body.contentType;
  return result;
}

async function flushEntry(
  draft: CassetteEntryDraft,
  store: CassetteStore,
  name: string,
): Promise<CassetteEntry> {
  const [reqBody, resBody] = await Promise.all([
    flushBody(draft.request.body, store, name),
    flushBody(draft.response.body, store, name),
  ]);
  return {
    ...draft,
    request: { ...draft.request, body: reqBody },
    response: { ...draft.response, body: resBody },
  };
}

function makeEntryId(
  matchKey: string,
  callIndex: number,
  body: BodyPayload,
): string {
  const raw = `${matchKey}\n${callIndex}\n${JSON.stringify(body)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ---- Public API -----------------------------------------------------------

export interface CassetteServerRoute {
  /**
   * Local path prefix that maps to `upstreamOrigin`.
   * Example: `{ prefix: "/openai", upstreamOrigin: "https://api.openai.com" }`
   * maps `/openai/v1/chat/completions` to
   * `https://api.openai.com/v1/chat/completions` for matching and recording.
   */
  prefix: string;
  /** Original provider origin to record in the cassette and proxy to in record mode. */
  upstreamOrigin: string;
}

export interface CassetteServerOptions {
  /** Logical cassette name. Maps to a path under the store's root directory. */
  name: string;
  /** Execution mode. Defaults to `'replay'`. */
  mode?: CassetteMode;
  /** Storage backend for cassette JSON and binary sidecars. */
  store: CassetteStore;
  /** Filter spec (matching-only normalization). */
  filters?: FilterSpec;
  /**
   * Full request URLs to answer with an empty 204 and exclude from recording
   * and replay matching. This is intended for background telemetry endpoints
   * that are nondeterministic and irrelevant to the scenario under test.
   */
  ignoredRequests?: IgnoredRequestMatcher[];
  /** Hook fired when `replay` mode encounters a miss. Called before the error throws. */
  onMiss?: (req: RecordedRequest) => void;
  /** Routes served by the local cassette server. */
  routes: CassetteServerRoute[];
  /** Host for the local server. Defaults to 127.0.0.1. */
  host?: string;
  /** Port for the local server. Defaults to an ephemeral port. */
  port?: number;
}

export interface CassetteServer {
  readonly name: string;
  readonly mode: CassetteMode;
  /** Local server URL after `start()` has completed. */
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function createContext(options: CassetteServerOptions): CassetteContext {
  return {
    name: options.name,
    mode: options.mode ?? "replay",
    store: options.store,
    matcher: createDefaultMatcher(),
    filters: options.filters,
    redact: "paranoid",
    ignoredRequests: options.ignoredRequests,
    threshold: DEFAULT_EXTERNAL_BLOB_THRESHOLD,
    onMiss: options.onMiss,
    candidates: [],
    callCounts: new Map(),
    newEntries: [],
    misses: [],
  };
}

/**
 * Create a local HTTP cassette server. Callers point SDK/provider base URLs at
 * route prefixes on `server.url`; requests are matched and persisted using the
 * original provider URL reconstructed from the configured route.
 */
export function createCassetteServer(
  options: CassetteServerOptions,
): CassetteServer {
  const ctx = createContext(options);
  const routes = normalizeRoutes(options.routes);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  let server: Server | undefined;
  let serverUrl: string | undefined;
  let started = false;
  const pendingRequests = new Set<Promise<void>>();

  async function handleIncoming(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const upstreamUrl = resolveUpstreamUrl(req, routes);
    if (!upstreamUrl) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "No cassette route matched request" }));
      return;
    }

    const request = await incomingMessageToRequest(req, upstreamUrl);
    const response = await handleCassetteRequest(ctx, request, () => {
      return globalThis.fetch(request);
    });
    await writeFetchResponse(res, response);
  }

  async function closeServer(): Promise<void> {
    const activeServer = server;
    if (!activeServer) return;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
    serverUrl = undefined;
  }

  return {
    get name() {
      return ctx.name;
    },
    get mode() {
      return ctx.mode;
    },
    get url() {
      if (!serverUrl) {
        throw new Error(
          `Cassette server "${ctx.name}" has not been started yet.`,
        );
      }
      return serverUrl;
    },

    async start() {
      if (started) {
        throw new Error(
          `Cassette server "${ctx.name}" is already started. Call stop() before starting again.`,
        );
      }

      resetContext(ctx);
      await loadCandidates(ctx);

      server = createServer((req, res) => {
        const work = handleIncoming(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
          }
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
        pendingRequests.add(work);
        work.finally(() => pendingRequests.delete(work));
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, () => {
          server!.off("error", reject);
          resolve();
        });
      });

      const address = server.address() as AddressInfo;
      serverUrl = `http://${host}:${address.port}`;
      started = true;
    },

    async stop() {
      if (!started) return;
      started = false;
      try {
        await closeServer();
        await Promise.all([...pendingRequests]);
        await persistIfRecord(ctx);
        throwFirstMiss(ctx);
      } finally {
        await closeServer();
      }
    },
  };
}

function normalizeRoutes(
  routes: CassetteServerRoute[],
): Array<{ prefix: string; upstreamOrigin: string }> {
  return routes
    .map((route) => ({
      prefix: normalizePrefix(route.prefix),
      upstreamOrigin: route.upstreamOrigin.replace(/\/+$/, ""),
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

function normalizePrefix(prefix: string): string {
  const normalized = `/${prefix.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return normalized === "/" ? "" : normalized;
}

function resolveUpstreamUrl(
  req: IncomingMessage,
  routes: Array<{ prefix: string; upstreamOrigin: string }>,
): string | null {
  const localUrl = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`,
  );

  for (const route of routes) {
    if (
      localUrl.pathname === route.prefix ||
      localUrl.pathname.startsWith(`${route.prefix}/`)
    ) {
      const suffix = localUrl.pathname.slice(route.prefix.length) || "/";
      return `${route.upstreamOrigin}${suffix}${localUrl.search}`;
    }
  }

  return null;
}

async function incomingMessageToRequest(
  req: IncomingMessage,
  upstreamUrl: string,
): Promise<Request> {
  const method = req.method ?? "GET";
  const init: RequestInit = {
    method,
    headers: sanitizeIncomingHeaders(req.headers),
  };
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    init.body = Buffer.concat(chunks);
  }
  return new Request(upstreamUrl, init);
}

function sanitizeIncomingHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  const skipped = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || skipped.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else {
      result.set(key, value);
    }
  }
  return result;
}

async function writeFetchResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const setCookies = (
    response.headers as Headers & { getSetCookie?(): string[] }
  ).getSetCookie?.();
  if (setCookies && setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } finally {
    res.end();
    reader.releaseLock();
  }
}
