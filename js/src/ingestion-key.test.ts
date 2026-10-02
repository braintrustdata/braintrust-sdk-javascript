import { createHash, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _internalGetGlobalState,
  Attachment,
  BraintrustState,
  constructLogs3OverflowRequest,
  ExternalAttachment,
  extractTraceContextFromHeaders,
  flush,
  initLogger,
  type InitLoggerOptions,
  setMaskingFunction,
  traced,
  updateSpan,
} from "./logger";
import {
  ingestionUploadChunkSchema,
  ingestionUploadCompleteSchema,
  ingestionUploadGrantSchema,
  parseIngestionKeyUrl,
} from "./ingestion-key";
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
  redirect: RequestRedirect | undefined;
  keepalive: boolean | undefined;
  signal: AbortSignal | undefined;
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
      redirect: init?.redirect,
      keepalive: init?.keepalive,
      signal: init?.signal ?? undefined,
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
      // The public server path rejects external attachment references.
      if (String(request.body).includes('"external_attachment"')) {
        return json({ error: "external attachments are not supported" }, 400);
      }
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
  return initIngestionLoggerWithKey(fetch, newKey(), options);
}

function initIngestionLoggerWithKey(
  fetch: typeof globalThis.fetch,
  key: string,
  options: InitLoggerOptions<true> = {},
) {
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

// Requests of the global (private) state never reach a real server.
const privateFetch = vi.fn(async (input: RequestInfo | URL) => {
  throw new Error(`Unexpected private request to ${String(input)}`);
});

beforeEach(() => {
  // Only flush explicitly, so the rows of a span are sent together.
  vi.stubEnv("BRAINTRUST_SYNC_FLUSH", "1");
  privateFetch.mockClear();
  _internalGetGlobalState().setFetch(
    privateFetch as unknown as typeof globalThis.fetch,
  );
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

  test("an explicit apiKey takes precedence over the environment", async () => {
    const { requests, fetch } = mockIngestion({ respond: () => json({}) });
    const key = newKey();
    vi.stubEnv("BRAINTRUST_INGESTION_KEY", ingestionUrl(key));
    const state = new BraintrustState({ fetch, noExitFlush: true });
    state.apiUrl = "https://api.test";
    state.loginToken = "private-api-key";
    state.apiConn().set_token("private-api-key");

    const logger = initLogger({
      state,
      apiKey: "private-api-key",
      projectId: "private-project",
      projectName: "private",
    });
    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(logger.loggingState).toBe(state);
    expect(paths(requests)).toEqual(["GET /version", "POST /logs3"]);
    expect(requests[1].headers.authorization).toBe("Bearer private-api-key");
    // The private transport keeps its keepalive requests.
    expect(requests[1].keepalive).toBe(true);
    expect(requests[1].redirect).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain(key);

    const apiKeyLogger = initLogger({ apiKey: "private-api-key" });
    expect(apiKeyLogger.loggingState).toBe(_internalGetGlobalState());
  });

  test("ignores the login of a supplied state", async () => {
    const { requests, fetch } = mockIngestion();
    const loggedInState = new BraintrustState({ fetch, noExitFlush: true });
    loggedInState.apiUrl = "https://api.test";
    loggedInState.loginToken = "private-api-key";
    loggedInState.loggedIn = true;
    const envKey = newKey();
    vi.stubEnv("BRAINTRUST_INGESTION_KEY", ingestionUrl(envKey));

    const fromEnv = initLogger({ state: loggedInState, noExitFlush: true });
    const explicit = initIngestionLogger(fetch, { state: loggedInState });
    fromEnv.log({ input: "env", output: "x" });
    explicit.logger.log({ input: "explicit", output: "x" });
    await flush({ state: loggedInState });

    expect(fromEnv.loggingState).not.toBe(loggedInState);
    expect(loggedInState.currentLogger).toBe(explicit.logger);
    expect(
      requests.map((r) => [r.headers.authorization, loggedRows([r])[0].input]),
    ).toEqual(
      expect.arrayContaining([
        [`Bearer ${envKey}`, "env"],
        [`Bearer ${explicit.key}`, "explicit"],
      ]),
    );
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain("private-api-key");
  });

  test("rejects an ingestion key combined with an apiKey", () => {
    const ingestionKey = ingestionUrl(newKey());
    expect(() => initLogger({ ingestionKey, apiKey: "private" })).toThrow(
      "either an ingestionKey or an apiKey",
    );
    expect(() => initLogger({ ingestionKey: "" })).toThrow(
      "Invalid Braintrust ingestion key",
    );
  });

  test("sends the ids of orgProjectMetadata for the server to check", async () => {
    const { requests, fetch } = mockIngestion();
    const orgProjectMetadata = {
      org_id: "org-id",
      project: { id: "project-id", name: "ignored", fullInfo: {} },
    };
    const { logger, onFlushError } = initIngestionLogger(fetch, {
      orgProjectMetadata,
    });

    logger.log({
      input: new Attachment({
        data: new ArrayBuffer(10),
        filename: "a.bin",
        contentType: "application/octet-stream",
      }),
      output: "x",
    });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(bodyJson(requests[0])).toMatchObject({
      purpose: "attachment",
      org_id: "org-id",
    });
    expect(loggedRows(requests)).toEqual([
      expect.objectContaining({ org_id: "org-id", project_id: "project-id" }),
    ]);
    expect(JSON.stringify(requests)).not.toContain("ignored");
    expect(() =>
      initIngestionLogger(fetch, {
        orgProjectMetadata,
        projectId: "other-project",
      }),
    ).toThrow("does not match");
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

  test("rejects external attachments before logging their rows", async () => {
    const { requests, fetch } = mockIngestion();
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({
      input: new ExternalAttachment({
        url: "s3://private-bucket/secret.pdf",
        filename: "secret.pdf",
        contentType: "application/pdf",
      }),
      output: "instance",
    });
    logger.log({
      input: {
        file: {
          type: "external_attachment",
          url: "s3://private-bucket/other.pdf",
          filename: "other.pdf",
          content_type: "application/pdf",
        },
      },
      output: "reference",
    });
    logger.log({ input: "kept", output: "kept" });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(String(onFlushError.mock.calls[0][0])).toContain(
      "do not support external attachments",
    );
    expect(loggedRows(requests).map((row) => row.output)).toEqual(["kept"]);
    expect(JSON.stringify(requests)).not.toContain("private-bucket");
  });

  test("keeps references to already committed attachments", async () => {
    const { requests, fetch } = mockIngestion();
    const { logger, onFlushError } = initIngestionLogger(fetch);
    const reference = {
      type: "braintrust_attachment",
      filename: "a.bin",
      content_type: "application/octet-stream",
      key: "server-committed-upload",
    };

    logger.log({ input: { file: reference }, output: "x" });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(paths(requests)).toEqual(["POST /deployment/base/ingest/v1/logs"]);
    expect(loggedRows(requests)[0].input.file).toEqual(reference);
  });

  test("keeps private external attachment behavior", async () => {
    const { requests, fetch } = mockIngestion({ respond: () => json({}) });
    const state = new BraintrustState({ fetch, noExitFlush: true });
    state.apiUrl = "https://api.test";
    const logger = initLogger({
      state,
      projectId: "private-project",
      projectName: "private",
    });

    logger.log({
      input: new ExternalAttachment({
        url: "s3://bucket/file.pdf",
        filename: "file.pdf",
        contentType: "application/pdf",
      }),
      output: "x",
    });
    await logger.flush();

    expect(paths(requests)).toEqual(["GET /version", "POST /logs3"]);
    expect(bodyJson(requests[1]).rows[0].input).toMatchObject({
      type: "external_attachment",
      url: "s3://bucket/file.pdf",
    });
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

describe("ingestion key transport", () => {
  test("refuses redirects and does not follow them", async () => {
    const { requests, fetch } = mockIngestion({
      respond: () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.example/v1/logs" },
        }),
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "2");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(String(onFlushError.mock.calls[0][0])).toContain("redirect");
    expect(paths(requests)).toEqual(["POST /deployment/base/ingest/v1/logs"]);
    expect(requests.every((r) => r.redirect === "error")).toBe(true);
  });

  test("asks fetch not to follow redirects for uploads", async () => {
    const { requests, fetch } = mockIngestion({ chunkBytes: 4 });
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({
      input: new Attachment({
        data: new ArrayBuffer(10),
        filename: "a.bin",
        contentType: "application/octet-stream",
      }),
      output: "x",
    });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(requests).toHaveLength(6);
    expect(requests.every((r) => r.redirect === "error")).toBe(true);
  });

  test("redacts the key from error responses", async () => {
    const key = newKey();
    const { fetch } = mockIngestion({
      respond: () =>
        new Response(`invalid Authorization: Bearer ${key}`, {
          status: 400,
          statusText: `Bad ${key}`,
        }),
    });
    const { logger, onFlushError } = initIngestionLoggerWithKey(fetch, key);

    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    const reported = inspect(onFlushError.mock.calls[0][0], { depth: 10 });
    expect(reported).not.toContain(key);
    expect(reported).toContain("Bearer [REDACTED]");
  });

  test("redacts the key from network errors", async () => {
    const key = newKey();
    const fetch = vi.fn(async () => {
      throw new TypeError(`connect failed for Bearer ${key}`, {
        cause: new Error(key),
      });
    }) as unknown as typeof globalThis.fetch;
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "0");
    const { logger, onFlushError } = initIngestionLoggerWithKey(fetch, key);

    logger.log({ input: "a", output: "b" });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    const reported = inspect(onFlushError.mock.calls[0][0], { depth: 10 });
    expect(reported).not.toContain(key);
    expect(reported).toContain("connect failed for Bearer [REDACTED]");
  });

  test("requests a new grant when the server reports it expired", async () => {
    let chunkRequests = 0;
    const { requests, fetch } = mockIngestion({
      respond: (request) =>
        request.url.includes("/chunks/") && chunkRequests++ === 0
          ? json({ error: "upload expired" }, 410)
          : undefined,
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "1");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({
      input: new Attachment({
        data: new ArrayBuffer(10),
        filename: "a.bin",
        contentType: "application/octet-stream",
      }),
      output: "x",
    });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    const grants = requests.filter((r) => r.url.endsWith("/v1/uploads"));
    expect(grants).toHaveLength(2);
    expect(loggedRows(requests)).toHaveLength(1);
  });

  test("aborts upload requests that outlive the grant", async () => {
    let grants = 0;
    const { requests, fetch } = mockIngestion({
      respond: (request) => {
        if (request.url.endsWith("/v1/uploads") && grants++ === 0) {
          return json(
            {
              upload_id: randomUUID(),
              chunk_bytes: 512 * KIB,
              num_chunks: 1,
              expires_in_ms: 50,
            },
            201,
          );
        }
        if (request.url.includes("/chunks/") && grants === 1) {
          // Hang until the grant expires.
          return new Promise<Response>((_, reject) =>
            request.signal!.addEventListener("abort", () =>
              reject(request.signal!.reason),
            ),
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
      output: "x",
    });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.url.endsWith("/v1/uploads"))).toHaveLength(
      2,
    );
    expect(
      requests.filter((r) => r.url.includes("/chunks/")).every((r) => r.signal),
    ).toBe(true);
    expect(loggedRows(requests)).toHaveLength(1);
  });

  test.each([
    ["an invalid grant", { upload_id: "not-a-uuid" }],
    [
      "an impossible chunk plan",
      {
        upload_id: "00000000-0000-4000-8000-000000000001",
        chunk_bytes: 4,
        num_chunks: 1,
        expires_in_ms: 300_000,
      },
    ],
  ])("does not retry %s", async (_, grant) => {
    const { requests, fetch } = mockIngestion({
      respond: (request) =>
        request.url.endsWith("/v1/uploads") ? json(grant, 201) : undefined,
    });
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "2");
    const { logger, onFlushError } = initIngestionLogger(fetch);

    logger.log({
      input: new Attachment({
        data: new ArrayBuffer(10),
        filename: "a.bin",
        contentType: "application/octet-stream",
      }),
      output: "x",
    });
    await logger.flush();

    expect(onFlushError).toHaveBeenCalledTimes(1);
    expect(String(onFlushError.mock.calls[0][0])).toContain(
      "Invalid response from ingestion endpoint",
    );
    expect(paths(requests)).toEqual([
      "POST /deployment/base/ingest/v1/uploads",
    ]);
  });

  test("sends native bodies above the browser keepalive limit", async () => {
    const mock = mockIngestion();
    // Like browsers, reject keepalive requests with bodies above 64 KiB.
    const browserFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.keepalive && String(init.body ?? "").length > 64 * KIB) {
        throw new TypeError("Failed to fetch");
      }
      return mock.fetch(input, init);
    }) as typeof globalThis.fetch;
    const { logger, onFlushError } = initIngestionLogger(browserFetch);

    logger.log({ input: "x".repeat(200 * KIB), output: "inline" });
    await logger.flush();

    expect(onFlushError).not.toHaveBeenCalled();
    expect(paths(mock.requests)).toEqual([
      "POST /deployment/base/ingest/v1/logs",
    ]);
    const [request] = mock.requests;
    expect(request.keepalive).toBe(false);
    expect(String(request.body).length).toBeGreaterThan(64 * KIB);
    expect(String(request.body).length).toBeLessThan(512 * KIB);
  });

  test("an empty BRAINTRUST_INGESTION_KEY fails instead of logging privately", () => {
    vi.stubEnv("BRAINTRUST_INGESTION_KEY", "");
    vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
    expect(() => initLogger({ noExitFlush: true })).toThrow(
      "Invalid Braintrust ingestion key",
    );
  });
});

describe("updateSpan with ingestion keys", () => {
  test("updates exported spans through the current ingestion key logger", async () => {
    const { requests, fetch } = mockIngestion();
    vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
    const { key, logger } = initIngestionLogger(fetch, {
      projectId: "project-id",
    });
    const span = logger.startSpan({ name: "root" });
    span.end();
    const exported = await span.export();

    updateSpan({ exported, output: "updated" });
    await flush();

    expect(privateFetch).not.toHaveBeenCalled();
    expect(
      requests.every((r) => r.headers.authorization === `Bearer ${key}`),
    ).toBe(true);
    expect(loggedRows(requests)).toContainEqual(
      expect.objectContaining({
        id: span.id,
        output: "updated",
        project_id: "project-id",
      }),
    );
  });

  test("updates exported spans without a project through the logger state", async () => {
    const { requests, fetch } = mockIngestion();
    const { key, logger } = initIngestionLogger(fetch, { setCurrent: false });
    const span = logger.startSpan({ name: "root" });
    span.end();
    const exported = await span.export();

    updateSpan({ exported, output: "updated", state: logger.loggingState });
    await logger.flush();

    const update = loggedRows(requests).find((row) => row.output === "updated");
    expect(update).toMatchObject({ id: span.id, log_id: "g" });
    expect(update).not.toHaveProperty("project_id");
    expect(
      requests.every((r) => r.headers.authorization === `Bearer ${key}`),
    ).toBe(true);
  });

  test("rejects exported spans without a project instead of using private credentials", async () => {
    const { requests, fetch } = mockIngestion();
    vi.stubEnv("BRAINTRUST_API_KEY", "private-api-key");
    const { logger } = initIngestionLogger(fetch, { setCurrent: false });
    const span = logger.startSpan({ name: "root" });
    span.end();
    const exported = await span.export();

    expect(() => updateSpan({ exported, output: "updated" })).toThrow(
      "exported without its project",
    );
    await flush();
    await logger.flush();
    expect(privateFetch).not.toHaveBeenCalled();
    expect(loggedRows(requests).some((row) => row.output === "updated")).toBe(
      false,
    );
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

// Cases from typespecs/src/public-ingestion.fixture.json in
// braintrustdata/braintrust at 74ce022558796700023b29a98dba448784fc69f2.
const FIXTURE_KEY = "bt-ik-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const FIXTURE_VALID_URLS: [string, string][] = [
  [
    `https://dp.example.com/ingest?ingestKey=${FIXTURE_KEY}`,
    "https://dp.example.com/ingest",
  ],
  [
    `https://dp.example.com/base/path/ingest?ingestKey=${FIXTURE_KEY}`,
    "https://dp.example.com/base/path/ingest",
  ],
  [
    `https://dp.example.com:8443/base/ingest/?ingestKey=${FIXTURE_KEY}`,
    "https://dp.example.com:8443/base/ingest",
  ],
  [
    `http://localhost:8000/ingest?ingestKey=${FIXTURE_KEY}`,
    "http://localhost:8000/ingest",
  ],
  [
    `https://dp.example.com/base/ingest///?ingestKey=${FIXTURE_KEY}`,
    "https://dp.example.com/base/ingest",
  ],
  [
    "https://dp.example.com/ingest?ingestKey=bt%2Dik%2DFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "https://dp.example.com/ingest",
  ],
  [
    `https://dp.example.com/ingest?ingest%4Bey=${FIXTURE_KEY}`,
    "https://dp.example.com/ingest",
  ],
];
const FIXTURE_INVALID_URLS: [string, string][] = [
  ["missing key", "https://dp.example.com/ingest"],
  [
    "path does not end with /ingest",
    `https://dp.example.com/base?ingestKey=${FIXTURE_KEY}`,
  ],
  [
    "not an ingestion key",
    // An API key shaped value, built here so it does not look like a secret.
    `https://dp.example.com/ingest?ingestKey=sk-${"FAKE".repeat(12)}`,
  ],
  [
    "truncated key",
    "https://dp.example.com/ingest?ingestKey=bt-ik-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK",
  ],
  [
    "extra query parameter",
    `https://dp.example.com/ingest?ingestKey=${FIXTURE_KEY}&project_id=foo`,
  ],
  [
    "repeated key parameter",
    `https://dp.example.com/ingest?ingestKey=${FIXTURE_KEY}&ingestKey=${FIXTURE_KEY}`,
  ],
  [
    "embedded credentials",
    `https://user:pass@dp.example.com/ingest?ingestKey=${FIXTURE_KEY}`,
  ],
  [
    "fragment",
    `https://dp.example.com/ingest?ingestKey=${FIXTURE_KEY}#fragment`,
  ],
  ["empty fragment", `https://dp.example.com/ingest?ingestKey=${FIXTURE_KEY}#`],
  [
    "unsupported protocol",
    `ftp://dp.example.com/ingest?ingestKey=${FIXTURE_KEY}`,
  ],
  ["bare key without a URL", `${FIXTURE_KEY}`],
];
const FIXTURE_UPLOAD = {
  grant: {
    upload_id: "00000000-0000-4000-8000-000000000001",
    chunk_bytes: 524288,
    num_chunks: 3,
    expires_in_ms: 300000,
  },
  chunk_response: { index: 2, size_bytes: 100 },
  complete_responses: [
    {
      reference: {
        type: "braintrust_attachment",
        filename: "image.png",
        content_type: "image/png",
        key: "server-issued/attachment-key",
      },
      size_bytes: 1048676,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      reference: {
        type: "logs3_overflow",
        key: "00000000-0000-4000-8000-000000000001",
      },
      size_bytes: 5242880,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  ],
  overflow_logs_request: {
    api_version: 2,
    rows: {
      type: "logs3_overflow",
      key: "00000000-0000-4000-8000-000000000001",
    },
  },
};
// [size_bytes, chunk_bytes, num_chunks, last_chunk_bytes]
const FIXTURE_CHUNK_PLANS: [number, number, number, number | null][] = [
  [0, 524288, 0, null],
  [1, 524288, 1, 1],
  [524288, 524288, 1, 524288],
  [524289, 524288, 2, 1],
  [2097252, 524288, 5, 100],
  [9437184, 4194304, 3, 1048576],
];

describe("shared public ingestion fixture", () => {
  test.each(FIXTURE_VALID_URLS)("parses %s", (url, root) => {
    expect(parseIngestionKeyUrl(url)).toEqual({ root, key: FIXTURE_KEY });
  });

  test.each(FIXTURE_INVALID_URLS)("rejects %s", (_, url) => {
    expect(() => parseIngestionKeyUrl(url)).toThrow(
      "Invalid Braintrust ingestion key",
    );
    try {
      parseIngestionKeyUrl(url);
    } catch (error) {
      expect(inspect(error)).not.toContain(FIXTURE_KEY);
    }
  });

  test("accepts the upload responses", () => {
    expect(ingestionUploadGrantSchema.parse(FIXTURE_UPLOAD.grant)).toEqual(
      FIXTURE_UPLOAD.grant,
    );
    expect(
      ingestionUploadChunkSchema.parse(FIXTURE_UPLOAD.chunk_response),
    ).toEqual(FIXTURE_UPLOAD.chunk_response);
    for (const response of FIXTURE_UPLOAD.complete_responses) {
      expect(ingestionUploadCompleteSchema.parse(response)).toEqual(response);
    }
    expect(
      constructLogs3OverflowRequest(FIXTURE_UPLOAD.grant.upload_id),
    ).toEqual(FIXTURE_UPLOAD.overflow_logs_request);
  });

  test.each(FIXTURE_CHUNK_PLANS)(
    "uploads %i bytes in chunks of %i",
    async (sizeBytes, chunkBytes, numChunks, lastChunkBytes) => {
      const { requests, fetch } = mockIngestion({ chunkBytes });
      const { logger, onFlushError } = initIngestionLogger(fetch);

      logger.log({
        input: new Attachment({
          data: new ArrayBuffer(sizeBytes),
          filename: "data.bin",
          contentType: "application/octet-stream",
        }),
        output: "x",
      });
      await logger.flush();

      expect(onFlushError).not.toHaveBeenCalled();
      const chunkSizes = requests
        .filter((r) => r.url.includes("/chunks/"))
        .map((r) => (r.body as Uint8Array).length);
      expect(chunkSizes).toHaveLength(numChunks);
      expect(chunkSizes.at(-1) ?? null).toBe(lastChunkBytes);
      expect(chunkSizes.slice(0, -1).every((size) => size === chunkBytes)).toBe(
        true,
      );
    },
  );
});
