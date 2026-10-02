import { createHash, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _internalGetGlobalState,
  Attachment,
  BraintrustState,
  extractTraceContextFromHeaders,
  flush,
  initLogger,
  type InitLoggerOptions,
  setMaskingFunction,
  traced,
} from "./logger";
import { parseIngestionKeyUrl } from "./ingestion-key";
import { configureNode } from "./node/config";

configureNode();

const KIB = 1024;

function newKey() {
  return `bt-ik-${randomUUID().replace(/-/g, "")}${"a".repeat(16)}`;
}

function ingestionUrl(
  key: string,
  base = "https://dp.example/deployment/base",
) {
  return `${base}/ingest?ingestKey=${key}`;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | string | undefined;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bodyJson(request: RecordedRequest) {
  return JSON.parse(String(request.body));
}

function paths(requests: RecordedRequest[]) {
  return requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
}

/**
 * Mock data plane that implements the ingestion upload and log endpoints.
 * `respond` can override the response of any request.
 */
function mockIngestion(
  options: {
    chunkBytes?: number;
    respond?: (
      request: RecordedRequest,
      index: number,
    ) => Response | Promise<Response | undefined> | undefined;
  } = {},
) {
  const requests: RecordedRequest[] = [];
  const uploads = new Map<
    string,
    { request: Record<string, unknown>; chunks: Uint8Array[] }
  >();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      init?.body instanceof Blob
        ? new Uint8Array(await init.body.arrayBuffer())
        : (init?.body as string | undefined);
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(
          ([k, v]) => [k.toLowerCase(), v],
        ),
      ),
      body,
    };
    requests.push(request);
    const override = await options.respond?.(request, requests.length - 1);
    if (override) {
      return override;
    }

    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path.endsWith("/v1/uploads")) {
      const uploadRequest = bodyJson(request);
      const chunkBytes = options.chunkBytes ?? 512 * KIB;
      const uploadId = randomUUID();
      uploads.set(uploadId, { request: uploadRequest, chunks: [] });
      return json(
        {
          upload_id: uploadId,
          chunk_bytes: chunkBytes,
          num_chunks: Math.ceil(uploadRequest.size_bytes / chunkBytes),
          expires_in_ms: 300_000,
        },
        201,
      );
    }
    const chunkMatch = /\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(path);
    if (request.method === "PUT" && chunkMatch) {
      const chunk = request.body as Uint8Array;
      uploads.get(chunkMatch[1])!.chunks[Number(chunkMatch[2])] = chunk;
      return json({ index: Number(chunkMatch[2]), size_bytes: chunk.length });
    }
    const completeMatch = /\/v1\/uploads\/([^/]+)\/complete$/.exec(path);
    if (request.method === "POST" && completeMatch) {
      const uploadId = completeMatch[1];
      const upload = uploads.get(uploadId)!;
      const data = Buffer.concat(upload.chunks);
      return json({
        reference:
          upload.request.purpose === "attachment"
            ? {
                type: "braintrust_attachment",
                filename: upload.request.filename,
                content_type: upload.request.content_type,
                key: `server-${uploadId}`,
              }
            : { type: "logs3_overflow", key: uploadId },
        size_bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
    if (request.method === "POST" && path.endsWith("/v1/logs")) {
      const payload = bodyJson(request);
      return json({
        ids: Array.isArray(payload.rows)
          ? payload.rows.map((row: { id: string }) => row.id)
          : [],
      });
    }
    return json({ error: "unexpected request" }, 404);
  });
  return {
    requests,
    uploads,
    fetch: fetch as unknown as typeof globalThis.fetch,
  };
}

function loggedRows(requests: RecordedRequest[]) {
  return requests
    .filter((r) => new URL(r.url).pathname.endsWith("/v1/logs"))
    .flatMap((r) => bodyJson(r).rows);
}

function initIngestionLogger(
  fetch: typeof globalThis.fetch,
  options: InitLoggerOptions<true> = {},
) {
  const key = newKey();
  const onFlushError = vi.fn();
  const logger = initLogger<true>({
    ingestionKey: ingestionUrl(key),
    fetch,
    noExitFlush: true,
    onFlushError,
    ...options,
  });
  return { key, logger, onFlushError };
}

beforeEach(() => {
  // Only flush explicitly, so the rows of a span are sent together.
  vi.stubEnv("BRAINTRUST_SYNC_FLUSH", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  _internalGetGlobalState().currentLogger = undefined;
});

describe("parseIngestionKeyUrl", () => {
  const key = newKey();

  test("keeps the deployment base path and strips the query", () => {
    expect(
      parseIngestionKeyUrl(`https://dp.example/a/b/ingest?ingestKey=${key}`),
    ).toEqual({ root: "https://dp.example/a/b/ingest", key });
    expect(
      parseIngestionKeyUrl(`http://localhost:8000/ingest//?ingestKey=${key}`),
    ).toEqual({ root: "http://localhost:8000/ingest", key });
  });

  test("decodes the query like URLSearchParams", () => {
    expect(
      parseIngestionKeyUrl(`https://dp.example/ingest?ingest%4Bey=${key}`),
    ).toEqual({ root: "https://dp.example/ingest", key });
  });

  test.each([
    ["a bare key", key],
    ["a non-http URL", `ftp://dp.example/ingest?ingestKey=${key}`],
    ["credentials", `https://user:pw@dp.example/ingest?ingestKey=${key}`],
    ["a fragment", `https://dp.example/ingest?ingestKey=${key}#x`],
    ["an empty fragment", `https://dp.example/ingest?ingestKey=${key}#`],
    [
      "another query parameter",
      `https://dp.example/ingest?ingestKey=${key}&a=b`,
    ],
    [
      "a repeated key",
      `https://dp.example/ingest?ingestKey=${key}&ingestKey=${key}`,
    ],
    ["a malformed key", "https://dp.example/ingest?ingestKey=sk-123"],
    [
      "a key of the wrong length",
      `https://dp.example/ingest?ingestKey=${key.slice(0, -1)}`,
    ],
    ["a different path", `https://dp.example/logs?ingestKey=${key}`],
  ])("rejects %s without echoing the key", (_, value) => {
    let error: unknown;
    try {
      parseIngestionKeyUrl(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error)).not.toContain(key);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("initLogger with an ingestion key", () => {
  test("first flush only posts rows to the ingestion endpoint", async () => {
    const { requests, fetch } = mockIngestion();
    vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
    const { key, logger, onFlushError } = initIngestionLogger(fetch, {
      projectName: "ignored-name",
    });

    logger.traced((span) => span.log({ input: "hi", output: "hello" }), {
      name: "root",
    });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe(
      "https://dp.example/deployment/base/ingest/v1/logs",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${key}`);
    const payload = bodyJson(request);
    expect(payload.api_version).toBe(2);
    expect(payload.rows).toHaveLength(1);
    const [row] = payload.rows;
    expect(row).toMatchObject({
      input: "hi",
      output: "hello",
      log_id: "g",
      span_attributes: { name: "root" },
    });
    expect(row).not.toHaveProperty("project_id");
    expect(row).not.toHaveProperty("org_id");
    expect(JSON.stringify(requests)).not.toContain("private-api-key");
    expect(JSON.stringify(requests)).not.toContain("ignored-name");
  });

  test("sends an explicit project id for the server to check", async () => {
    const { requests, fetch } = mockIngestion({
      respond: (request) =>
        request.url.endsWith("/v1/logs")
          ? json({ error: "project mismatch" }, 403)
          : undefined,
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "0");
    const { logger, onFlushError } = initIngestionLogger(fetch, {
      projectId: "other-project",
    });

    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(loggedRows(requests)).toEqual([
      expect.objectContaining({ project_id: "other-project", log_id: "g" }),
    ]);
    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(String(onFlushError.mock.calls[0][0])).toContain("403");
  });

  test("uses BRAINTRUST_INGESTION_KEY and ignores private credentials", async () => {
    const { requests, fetch } = mockIngestion();
    const key = newKey();
    vi.stubEnv("BRAINTRUST_INGESTION_KEY", ingestionUrl(key));
    vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
    const globalState = _internalGetGlobalState();
    globalState.apiUrl = "https://api.test";
    globalState.loginToken = "private-api-key";
    globalState.loggedIn = true;

    const logger = initLogger({ fetch, noExitFlush: true });
    logger.log({ input: "a", output: "b" });
    await flush();

    expect(paths(requests)).toEqual(["POST /deployment/base/ingest/v1/logs"]);
    expect(requests[0].headers.authorization).toBe(`Bearer ${key}`);
    globalState.resetLoginInfo();
  });

  test("an explicit private credential takes precedence over the environment", async () => {
    const { requests, fetch } = mockIngestion({ respond: () => json({}) });
    const key = newKey();
    vi.stubEnv("BRAINTRUST_INGESTION_KEY", ingestionUrl(key));
    const state = new BraintrustState({ fetch, noExitFlush: true });
    state.apiUrl = "https://api.test";
    state.loginToken = "private-api-key";
    state.apiConn().set_token("private-api-key");

    const logger = initLogger({
      state,
      projectId: "private-project",
      projectName: "private",
    });
    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(logger.loggingState).toBe(state);
    expect(paths(requests)).toEqual(["GET /version", "POST /logs3"]);
    expect(requests[1].headers.authorization).toBe("Bearer private-api-key");
    expect(JSON.stringify(requests)).not.toContain(key);

    const apiKeyLogger = initLogger({ apiKey: "private-api-key" });
    expect(apiKeyLogger.loggingState).toBe(_internalGetGlobalState());
  });

  test("rejects an ingestion key combined with private credentials", () => {
    const ingestionKey = ingestionUrl(newKey());
    const loggedInState = new BraintrustState({});
    loggedInState.loginToken = "private";
    for (const options of [
      { apiKey: "private" },
      { state: new BraintrustState({ apiKey: "private" }) },
      { state: loggedInState },
    ]) {
      expect(() => initLogger({ ingestionKey, ...options })).toThrow(
        "either an ingestionKey or an API key",
      );
    }
    expect(() => initLogger({ ingestionKey: "" })).toThrow(
      "Invalid Braintrust ingestion key",
    );
  });

  test("uses a state without credentials for masking and the current logger", async () => {
    const { requests, fetch } = mockIngestion();
    vi.stubEnv("BRAINTRUST_INGESTION_KEY", ingestionUrl(newKey()));
    const contextState = new BraintrustState({ noExitFlush: true });
    contextState.setMaskingFunction((value) =>
      value === "secret-value" ? "[masked]" : value,
    );

    const logger = initLogger({
      state: contextState,
      fetch,
      noExitFlush: true,
    });
    logger.traced(
      (root) =>
        root.traced((span) => span.log({ input: "secret-value" }), {
          name: "child",
        }),
      { name: "root" },
    );
    await flush({ state: contextState });

    expect(logger.loggingState).not.toBe(contextState);
    expect(contextState.currentLogger).toBe(logger);
    expect(_internalGetGlobalState().currentLogger).toBeUndefined();
    expect(paths(requests)).toEqual(["POST /deployment/base/ingest/v1/logs"]);
    const rows = Object.fromEntries(
      loggedRows(requests).map((row) => [row.span_attributes.name, row]),
    );
    expect(rows.child.input).toBe("[masked]");
    expect(rows.child.span_parents).toEqual([rows.root.span_id]);
  });

  test("public and private loggers do not share queues or credentials", async () => {
    const { requests, fetch } = mockIngestion({
      respond: (request) =>
        new URL(request.url).host === "api.test" ? json({}) : undefined,
    });
    const privateState = new BraintrustState({ fetch, noExitFlush: true });
    privateState.apiUrl = "https://api.test";
    privateState.loginToken = "private-api-key";
    privateState.apiConn().set_token("private-api-key");
    const privateLogger = initLogger({
      state: privateState,
      projectId: "private-project",
      projectName: "private",
    });
    const first = initIngestionLogger(fetch);
    const second = initIngestionLogger(fetch);

    privateLogger.log({ input: "private", output: "x" });
    first.logger.log({ input: "first", output: "x" });
    second.logger.log({ input: "second", output: "x" });
    await Promise.all([
      privateLogger.flush(),
      first.logger.flush(),
      second.logger.flush(),
    ]);

    const inputsByAuth = Object.fromEntries(
      requests
        .filter((r) => r.method === "POST")
        .map((r) => [
          r.headers.authorization,
          bodyJson(r).rows.map((row: { input: string }) => row.input),
        ]),
    );
    expect(inputsByAuth).toEqual({
      "Bearer private-api-key": ["private"],
      [`Bearer ${first.key}`]: ["first"],
      [`Bearer ${second.key}`]: ["second"],
    });
    expect(
      requests
        .filter((r) => r.headers.authorization !== "Bearer private-api-key")
        .every((r) => r.url.startsWith("https://dp.example/")),
    ).toBe(true);
  });

  test("retries throttled writes after Retry-After against the ingestion endpoint only", async () => {
    const { requests, fetch } = mockIngestion({
      respond: (request, index) =>
        index === 0
          ? new Response("slow down", {
              status: 429,
              headers: { "Retry-After": "0" },
            })
          : undefined,
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "1");
    vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({ input: "a", output: "b" });
    const start = Date.now();
    await logger.flush();

    // Without Retry-After, the first retry waits one second.
    expect(Date.now() - start).toBeLessThan(900);
    expect(onFlushError).not.toHaveBeenCalled();
    expect(paths(requests)).toEqual([
      "POST /deployment/base/ingest/v1/logs",
      "POST /deployment/base/ingest/v1/logs",
    ]);
  });

  test("retries transient server errors", async () => {
    const { requests, fetch } = mockIngestion({
      respond: (request, index) =>
        index === 0 ? json({ error: "unavailable" }, 503) : undefined,
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "1");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(loggedRows(requests.slice(1))).toEqual([
      expect.objectContaining({ input: "a" }),
    ]);
  });

  test.each([401, 403, 400])(
    "does not retry a write rejected with %i",
    async (status) => {
      const { requests, fetch } = mockIngestion({
        respond: () => json({ error: "rejected" }, status),
      });
      vi.stubEnv("BRAINTRUST_NUM_RETRIES", "2");
      vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
      const { logger, onFlushError } = initIngestionLogger(fetch);

      logger.log({ input: "a", output: "b" });
      await logger.flush();

      expect(onFlushError).toHaveBeenCalledTimes(1);
      expect(paths(requests)).toEqual(["POST /deployment/base/ingest/v1/logs"]);
    },
  );

  test("does not request new upload grants after a permanent rejection", async () => {
    const { requests, fetch } = mockIngestion({
      respond: (request) =>
        request.url.includes("/chunks/")
          ? json({ error: "forbidden" }, 403)
          : undefined,
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "2");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({
      input: new Attachment({
        data: new ArrayBuffer(10),
        filename: "a.bin",
        contentType: "application/octet-stream",
      }),
      output: "dropped",
    });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(paths(requests).filter((p) => p.endsWith("/v1/uploads"))).toEqual([
      "POST /deployment/base/ingest/v1/uploads",
    ]);
    expect(loggedRows(requests)).toEqual([]);
  });

  test("gives up after the configured retries without a private fallback", async () => {
    const { requests, fetch } = mockIngestion({
      respond: () => json({ error: "unavailable" }, 503),
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "0");
    vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(paths(requests)).toEqual(["POST /deployment/base/ingest/v1/logs"]);
  });

  test("uploads attachments in advertised chunks before logging rows", async () => {
    const { requests, uploads, fetch } = mockIngestion({ chunkBytes: 4 * KIB });
    const { logger, onFlushError } = initIngestionLogger(fetch);
    const data = new Uint8Array(9 * KIB).map((_, i) => i % 251);
    const attachment = new Attachment({
      data: data.buffer,
      filename: "data.bin",
      contentType: "application/octet-stream",
    });

    logger.log({ input: { file: attachment }, output: "ok" });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    const [uploadId] = uploads.keys();
    expect(paths(requests)).toEqual([
      "POST /deployment/base/ingest/v1/uploads",
      `PUT /deployment/base/ingest/v1/uploads/${uploadId}/chunks/0`,
      `PUT /deployment/base/ingest/v1/uploads/${uploadId}/chunks/1`,
      `PUT /deployment/base/ingest/v1/uploads/${uploadId}/chunks/2`,
      `POST /deployment/base/ingest/v1/uploads/${uploadId}/complete`,
      "POST /deployment/base/ingest/v1/logs",
    ]);
    expect(bodyJson(requests[0])).toEqual({
      purpose: "attachment",
      filename: "data.bin",
      content_type: "application/octet-stream",
      size_bytes: data.length,
    });
    expect(
      requests
        .slice(1, 4)
        .map((r) => [r.headers["content-type"], (r.body as Uint8Array).length]),
    ).toEqual([
      ["application/octet-stream", 4 * KIB],
      ["application/octet-stream", 4 * KIB],
      ["application/octet-stream", 1 * KIB],
    ]);
    expect(bodyJson(requests[4])).toEqual({});
    expect(loggedRows(requests)[0].input.file).toEqual({
      type: "braintrust_attachment",
      filename: "data.bin",
      content_type: "application/octet-stream",
      key: `server-${uploadId}`,
    });
  });

  test("uploads empty attachments without chunks", async () => {
    const { requests, uploads, fetch } = mockIngestion();
    const { logger, onFlushError } = initIngestionLogger(fetch);
    const attachment = new Attachment({
      data: new ArrayBuffer(0),
      filename: "empty.txt",
      contentType: "text/plain",
    });

    logger.log({ input: attachment, output: "ok" });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    const [uploadId] = uploads.keys();
    expect(paths(requests)).toEqual([
      "POST /deployment/base/ingest/v1/uploads",
      `POST /deployment/base/ingest/v1/uploads/${uploadId}/complete`,
      "POST /deployment/base/ingest/v1/logs",
    ]);
    expect(bodyJson(requests[0]).size_bytes).toBe(0);
    expect(loggedRows(requests)[0].input.key).toBe(`server-${uploadId}`);
  });

  test("drops rows whose attachment failed to upload", async () => {
    const { requests, fetch } = mockIngestion({
      respond: (request) =>
        request.url.endsWith("/v1/uploads")
          ? json({ error: "quota" }, 429)
          : undefined,
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "0");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({
      input: new Attachment({
        data: new ArrayBuffer(10),
        filename: "a.bin",
        contentType: "application/octet-stream",
      }),
      output: "dropped",
    });
    logger.log({ input: "kept", output: "kept" });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(loggedRows(requests).map((row) => row.output)).toEqual(["kept"]);
    expect(requests.some((r) => r.url.includes("/attachment"))).toBe(false);
  });

  test("restarts an upload whose grant expired", async () => {
    let grants = 0;
    const { requests, fetch } = mockIngestion({
      respond: async (request) => {
        if (request.url.endsWith("/v1/uploads") && grants++ === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return json(
            {
              upload_id: randomUUID(),
              chunk_bytes: 512 * KIB,
              num_chunks: 1,
              expires_in_ms: 1,
            },
            201,
          );
        }
        return undefined;
      },
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "1");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({
      input: new Attachment({
        data: new ArrayBuffer(10),
        filename: "a.bin",
        contentType: "application/octet-stream",
      }),
      output: "ok",
    });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(
      paths(requests).filter((p) => p.endsWith("/v1/uploads")),
    ).toHaveLength(2);
    expect(paths(requests).filter((p) => p.includes("/chunks/"))).toHaveLength(
      1,
    );
  });

  test("overflows large batches through an upload", async () => {
    const { requests, uploads, fetch } = mockIngestion({ chunkBytes: 1 * KIB });
    vi.stubEnv("BRAINTRUST_MAX_REQUEST_SIZE", String(2 * KIB));
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({ input: "x".repeat(3 * KIB), output: "big" });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    const [[uploadId, upload]] = uploads.entries();
    expect(upload.request).toMatchObject({
      purpose: "logs3_overflow",
      content_type: "application/json",
    });
    expect(upload.request).not.toHaveProperty("filename");
    const uploaded = JSON.parse(Buffer.concat(upload.chunks).toString("utf8"));
    expect(uploaded.api_version).toBe(2);
    expect(uploaded.rows).toEqual([
      expect.objectContaining({ output: "big", log_id: "g" }),
    ]);
    const logRequests = requests.filter((r) => r.url.endsWith("/v1/logs"));
    expect(logRequests.map(bodyJson)).toEqual([
      { api_version: 2, rows: { type: "logs3_overflow", key: uploadId } },
    ]);
    expect(
      requests
        .filter((r) => r.url.includes("/chunks/"))
        .every((r) => (r.body as Uint8Array).length <= 1 * KIB),
    ).toBe(true);
  });

  test("overflows payloads above 512 KiB by default", async () => {
    const { requests, uploads, fetch } = mockIngestion();
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({ input: "x".repeat(400 * KIB), output: "inline" });
    await logger.flush();
    expect(uploads.size).toBe(0);
    expect(loggedRows(requests)).toEqual([
      expect.objectContaining({ output: "inline" }),
    ]);

    logger.log({ input: "x".repeat(600 * KIB), output: "overflow" });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    const [uploadId] = uploads.keys();
    expect(paths(requests).slice(1)).toEqual([
      "POST /deployment/base/ingest/v1/uploads",
      `PUT /deployment/base/ingest/v1/uploads/${uploadId}/chunks/0`,
      `PUT /deployment/base/ingest/v1/uploads/${uploadId}/chunks/1`,
      `POST /deployment/base/ingest/v1/uploads/${uploadId}/complete`,
      "POST /deployment/base/ingest/v1/logs",
    ]);
    expect(
      requests.every((r) => r.body === undefined || r.body.length <= 512 * KIB),
    ).toBe(true);
  });

  test("only sends supported row fields", async () => {
    const { requests, fetch } = mockIngestion();
    const { logger } = initIngestionLogger(fetch);

    const id = logger.log({ input: "a", output: "b" });
    logger.logFeedback({ id, scores: { good: 1 }, metadata: { user: "u" } });
    expect(() => logger.logFeedback({ id, comment: "nice" })).toThrow(
      "do not support logging comments",
    );
    await logger.flush();

    const rows = loggedRows(requests);
    expect(rows).toContainEqual(
      expect.objectContaining({ id, scores: { good: 1 } }),
    );
    for (const row of rows) {
      expect(row).not.toHaveProperty("_audit_source");
      expect(row).not.toHaveProperty("_audit_metadata");
      expect(row).not.toHaveProperty("comment");
    }
  });

  test("applies the global masking function", async () => {
    const { requests, fetch } = mockIngestion();
    const { logger } = initIngestionLogger(fetch);
    setMaskingFunction((value) =>
      value === "secret-value" ? "[masked]" : value,
    );
    try {
      logger.log({ input: "secret-value", output: "b" });
      await logger.flush();
    } finally {
      setMaskingFunction(null);
    }

    expect(loggedRows(requests)[0].input).toBe("[masked]");
  });

  test("never exposes the key in URLs or state", async () => {
    const { requests, fetch } = mockIngestion();
    const { key, logger } = initIngestionLogger(fetch);

    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(requests.every((r) => !r.url.includes(key))).toBe(true);
    expect(inspect(logger.loggingState)).not.toContain(key);
    expect(JSON.stringify(logger.loggingState)).not.toContain(key);
    expect(String(logger.loggingState)).not.toContain(key);
  });
});

describe("flush with ingestion keys", () => {
  test("drains every ingestion key queue, not only the current logger", async () => {
    const { requests, fetch } = mockIngestion();
    const first = initIngestionLogger(fetch);
    const second = initIngestionLogger(fetch);
    first.logger.log({ input: "first", output: "x" });
    second.logger.log({ input: "second", output: "x" });
    const privateLogger = initLogger({ apiKey: "private-api-key" });
    expect(_internalGetGlobalState().currentLogger).toBe(privateLogger);

    await flush();

    expect(
      Object.fromEntries(
        requests.map((r) => [
          r.headers.authorization,
          loggedRows([r])[0].input,
        ]),
      ),
    ).toEqual({
      [`Bearer ${first.key}`]: "first",
      [`Bearer ${second.key}`]: "second",
    });
  });
});

describe("tracing with an ingestion key", () => {
  test("nests and propagates spans without project metadata", async () => {
    const { requests, fetch } = mockIngestion();
    const { key, logger, onFlushError } = initIngestionLogger(fetch);

    let exported = "";
    let headers: Record<string, string> = {};
    logger.traced(
      (root) => {
        logger.traced(
          async (child) => {
            exported = await child.export();
          },
          { name: "child" },
        );
        headers = root.inject();
      },
      { name: "root" },
    );
    await vi.waitFor(() => expect(exported).not.toBe(""));
    // Exporting and injecting neither logs in nor looks up the project.
    expect(requests).toHaveLength(0);
    expect(exported).not.toContain(key);
    expect(JSON.stringify(headers)).not.toContain(key);

    const remote = logger.startSpan({
      name: "remote",
      parent: extractTraceContextFromHeaders(headers),
    });
    remote.end();
    traced(() => {}, { name: "global", parent: exported });
    await flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(paths(requests).every((p) => p.endsWith("/v1/logs"))).toBe(true);
    const rows = Object.fromEntries(
      loggedRows(requests)
        .filter((row) => row.span_attributes?.name)
        .map((row) => [row.span_attributes.name, row]),
    );
    expect(Object.keys(rows).sort()).toEqual([
      "child",
      "global",
      "remote",
      "root",
    ]);
    expect(rows.child.root_span_id).toBe(rows.root.root_span_id);
    expect(rows.child.span_parents).toEqual([rows.root.span_id]);
    expect(rows.remote.root_span_id).toBe(rows.root.root_span_id);
    expect(rows.remote.span_parents).toEqual([rows.root.span_id]);
    expect(rows.global.root_span_id).toBe(rows.root.root_span_id);
    expect(rows.global.span_parents).toEqual([rows.child.span_id]);
    for (const row of Object.values(rows)) {
      expect(row).not.toHaveProperty("project_id");
    }
    expect(headers.baggage ?? "").not.toContain("braintrust.parent");
  });
});
