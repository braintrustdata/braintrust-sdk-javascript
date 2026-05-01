import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SetupServer } from "msw/node";
import { setupServer } from "msw/node";
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
import { asNormalized, createDefaultMatcher } from "./matcher";
import type { MatchCandidate, Matcher } from "./matcher";
import {
  applyRequestRedaction,
  applyResponseRedaction,
  checkStrictRedaction,
  resolveRedactors,
} from "./redactor";
import type { RedactionSpec } from "./redactor";
import type {
  BodyOrDraft,
  RecordedRequestOrDraft,
  RecordedResponseOrDraft,
} from "./msw";
import {
  HttpResponse,
  buildResponse,
  bypass,
  http,
  passthrough,
  recordRequest,
  recordRequestDraft,
  recordResponseDraft,
} from "./msw";
import type { CassetteStore } from "./store";
import { createJsonFileStore } from "./store";

// Injected at build time by tsup define. Falls back to 'dev' when running
// directly via ts-node / vitest without a build step.
declare const __SEINFELD_VERSION__: string;
const SEINFELD_VERSION: string =
  typeof __SEINFELD_VERSION__ !== "undefined" ? __SEINFELD_VERSION__ : "dev";

const DEFAULT_CASSETTE_DIR = "./__cassettes__";
const DEFAULT_EXTERNAL_BLOB_THRESHOLD = 65536;

function resolveThreshold(
  opt: number | "always-inline" | false | undefined,
): number | false {
  if (opt === undefined) return DEFAULT_EXTERNAL_BLOB_THRESHOLD;
  if (opt === "always-inline" || opt === false) return false;
  return opt;
}

// ---- Internal draft types ------------------------------------------------

type CassetteEntryDraft = Omit<CassetteEntry, "request" | "response"> & {
  request: RecordedRequestOrDraft;
  response: RecordedResponseOrDraft;
};

// ---- Per-cassette context stored in ALS ----------------------------------

interface CassetteContext {
  // Static config (set at createCassette time, never mutated)
  name: string;
  mode: CassetteMode;
  store: CassetteStore;
  matcher: Matcher;
  filters: FilterSpec | undefined;
  redact: RedactionSpec | undefined;
  hosts: Array<string | RegExp> | undefined;
  passthroughHosts: Array<string | RegExp> | undefined;
  threshold: number | false;
  onMiss: ((req: RecordedRequest) => void) | undefined;
  onMatch: ((entry: CassetteEntry, req: RecordedRequest) => void) | undefined;
  onRecord: ((entry: CassetteEntry) => void) | undefined;
  onPersist: ((cassette: CassetteFile) => void) | undefined;

  // Per-run mutable state (reset on each start)
  candidates: MatchCandidate[];
  callCounts: Map<string, number>;
  newEntries: CassetteEntryDraft[];
  misses: CassetteMissError[];
}

// ---- Shared MSW server (refcounted) --------------------------------------

const als = new AsyncLocalStorage<CassetteContext>();
let sharedServer: SetupServer | undefined;
let serverRefcount = 0;

function acquireServer(): void {
  if (serverRefcount === 0) {
    sharedServer = setupServer(buildHandler());
    sharedServer.listen({ onUnhandledRequest: "bypass" });
  }
  serverRefcount++;
}

function releaseServer(): void {
  serverRefcount--;
  if (serverRefcount === 0 && sharedServer) {
    sharedServer.close();
    sharedServer = undefined;
  }
}

// ---- Static catch-all handler reads from ALS ----------------------------

function buildHandler() {
  return http.all("*", async ({ request }) => {
    const ctx = als.getStore();
    if (!ctx) return passthrough();
    if (!shouldIntercept(request.url, ctx.hosts)) return passthrough();
    if (isPassthroughHost(request.url, ctx.passthroughHosts))
      return passthrough();

    switch (ctx.mode) {
      case "replay": {
        const recorded = await recordRequest(request, ctx.threshold);
        return handleReplay(ctx, recorded);
      }
      case "record": {
        const draft = await recordRequestDraft(request, ctx.threshold);
        return handleRecord(ctx, request, draft);
      }
      case "passthrough":
        return passthrough();
    }
  });
}

function shouldIntercept(
  url: string,
  hosts: Array<string | RegExp> | undefined,
): boolean {
  if (!hosts || hosts.length === 0) return true;
  const parsed = new URL(url);
  return hosts.some((h) =>
    typeof h === "string" ? parsed.host === h : h.test(parsed.host),
  );
}

function isPassthroughHost(
  url: string,
  passthroughHosts: Array<string | RegExp> | undefined,
): boolean {
  if (!passthroughHosts || passthroughHosts.length === 0) return false;
  const parsed = new URL(url);
  return passthroughHosts.some((h) =>
    typeof h === "string" ? parsed.host === h : h.test(parsed.host),
  );
}

// ---- Per-request handlers (free functions, take ctx) --------------------

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
    return Promise.resolve(HttpResponse.error());
  }

  ctx.onMatch?.(match, recorded);
  return buildResponse(match.response, { store: ctx.store, name: ctx.name });
}

async function handleRecord(
  ctx: CassetteContext,
  request: Request,
  recorded: RecordedRequestOrDraft,
): Promise<Response> {
  const realResponse = await fetch(bypass(request));
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

  // Return the real response to the caller. recordResponseDraft only used
  // .clone() internally, so realResponse body is still available to clone.
  return realResponse.clone();
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
  const configs = resolveRedactors(ctx.redact);
  const strictConfigs = configs.filter((c) => c.strict);
  if (strictConfigs.length > 0) {
    checkStrictRedaction(ctx.name, flushedEntries, strictConfigs);
  }
  if (ctx.onRecord) {
    for (const entry of flushedEntries) ctx.onRecord(entry);
  }
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
  ctx.onPersist?.(cassette);
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
        "Use createJsonFileStore or createMemoryStore, or set externalBlobThreshold: false.",
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

// ---- Public API ----------------------------------------------------------

/** Options for `createCassette`. See README for full semantics. */
export interface CassetteOptions {
  /** Logical cassette name. Maps to a path under the store's root directory. */
  name: string;
  /** Execution mode. Defaults to `'replay'`. */
  mode?: CassetteMode;
  /** Storage backend. Defaults to a JSON file store at `./__cassettes__`. */
  store?: CassetteStore;
  /** Filter spec (matching-only normalization). */
  filters?: FilterSpec;
  /** Redaction spec (applied to persisted bytes). Defaults to none. */
  redact?: RedactionSpec;
  /** Hosts to intercept. Other hosts pass through. Defaults to all hosts. */
  hosts?: Array<string | RegExp>;
  /**
   * Hosts to always pass through, regardless of `hosts`. Useful for a local
   * mock server that should never be intercepted (e.g. the Braintrust mock
   * server in e2e tests).
   */
  passthroughHosts?: Array<string | RegExp>;
  /** Custom request matcher. Defaults to method+url+body equality. */
  matcher?: Matcher;
  /** Hook fired when `replay` mode encounters a miss. Called before the error throws. */
  onMiss?: (req: RecordedRequest) => void;
  /** Hook fired on every successful replay match. */
  onMatch?: (entry: CassetteEntry, req: RecordedRequest) => void;
  /** Hook fired when a new entry is captured in `record` mode. */
  onRecord?: (entry: CassetteEntry) => void;
  /** Hook fired after the cassette is persisted in `record` mode. */
  onPersist?: (cassette: CassetteFile) => void;
  /**
   * Byte threshold above which binary bodies are stored as external sidecar
   * files rather than inlined as base64 in the cassette JSON.
   *
   * Defaults to `65536` (64 KiB). Pass `'always-inline'` (or the deprecated
   * `false`) to always inline binary bodies as base64.
   * Only applies in `record` mode.
   */
  externalBlobThreshold?: number | "always-inline" | false;
}

/** The lifecycle handle returned by `createCassette`. */
export interface Cassette {
  readonly name: string;
  readonly mode: CassetteMode;
  /** Activate interception. In `passthrough` mode this is a no-op. */
  start(): Promise<void>;
  /** Tear down interception. In `record` mode this also persists the cassette. */
  stop(): Promise<void>;
  /** Convenience wrapper: `start()`, run `fn`, `stop()` (even on error). */
  use<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a cassette controller. Call `start()` (or `use()`) to activate
 * interception. See README for full configuration reference.
 */
export function createCassette(options: CassetteOptions): Cassette {
  const ctx: CassetteContext = {
    name: options.name,
    mode: options.mode ?? "replay",
    store:
      options.store ?? createJsonFileStore({ rootDir: DEFAULT_CASSETTE_DIR }),
    matcher: options.matcher ?? createDefaultMatcher(),
    filters: options.filters,
    redact: options.redact,
    hosts: options.hosts,
    passthroughHosts: options.passthroughHosts,
    threshold: resolveThreshold(options.externalBlobThreshold),
    onMiss: options.onMiss,
    onMatch: options.onMatch,
    onRecord: options.onRecord,
    onPersist: options.onPersist,
    candidates: [],
    callCounts: new Map(),
    newEntries: [],
    misses: [],
  };

  // Track the previous ALS store so start()/stop() can restore it (stack
  // semantics for manual lifecycle callers). Also track started state to guard
  // against double-start and stop-without-start.
  let prevStore: CassetteContext | undefined;
  let started = false;

  return {
    get name() {
      return ctx.name;
    },
    get mode() {
      return ctx.mode;
    },

    async start() {
      if (ctx.mode === "passthrough") return;
      if (started)
        throw new Error(
          `Cassette "${ctx.name}" is already started. Call stop() before starting again.`,
        );
      prevStore = als.getStore();
      als.enterWith(ctx);
      acquireServer();
      started = true;
      try {
        resetContext(ctx);
        await loadCandidates(ctx);
      } catch (err) {
        // Roll back: release the server we just acquired so refcount stays balanced.
        started = false;
        releaseServer();
        if (prevStore !== undefined) als.enterWith(prevStore);
        throw err;
      }
    },

    async stop() {
      if (ctx.mode === "passthrough") return;
      if (!started) return;
      started = false;
      try {
        await persistIfRecord(ctx);
        throwFirstMiss(ctx);
      } finally {
        releaseServer();
        // Restore the previous ALS context so code running after stop() in
        // the same async chain sees the outer cassette (or none).
        if (prevStore !== undefined) {
          als.enterWith(prevStore);
        }
      }
    },

    use<T>(fn: () => Promise<T>): Promise<T> {
      if (ctx.mode === "passthrough") return fn();

      return als.run(ctx, async () => {
        acquireServer();
        resetContext(ctx);
        await loadCandidates(ctx);
        try {
          const result = await fn();
          await persistIfRecord(ctx);
          throwFirstMiss(ctx);
          return result;
        } catch (err) {
          // Prefer a structured CassetteMissError over the network-level
          // TypeError that HttpResponse.error() produces in the caller.
          throwFirstMiss(ctx);
          throw err;
        } finally {
          releaseServer();
        }
      });
    },
  };
}
