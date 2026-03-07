import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CapturedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string;
  jsonBody: JsonValue | null;
}

export type CapturedLogRow = Record<string, unknown>;

export type CapturedLogPayload = {
  api_version: number;
  rows: CapturedLogRow[];
};

export type CapturedLogEvent = {
  apiVersion: number;
  context?: Record<string, unknown>;
  expected?: unknown;
  experimentId?: string;
  input?: unknown;
  isMerge: boolean;
  metadata?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  output?: unknown;
  projectId?: string;
  row: CapturedLogRow;
  scores?: unknown;
  span: {
    ended: boolean;
    id?: string;
    name?: string;
    parentIds: string[];
    rootId?: string;
    started: boolean;
    type?: string;
  };
};

export interface MockBraintrustServer {
  apiKey: string;
  close: () => Promise<void>;
  events: CapturedLogEvent[];
  payloads: CapturedLogPayload[];
  requests: CapturedRequest[];
  url: string;
}

const DEFAULT_API_KEY = "mock-braintrust-api-key";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  return Object.entries(headers).reduce<Record<string, string>>(
    (normalized, [key, value]) => {
      if (value === undefined) {
        return normalized;
      }

      normalized[key] = Array.isArray(value) ? value.join(", ") : value;
      return normalized;
    },
    {},
  );
}

function parseJson(rawBody: string): JsonValue | null {
  if (!rawBody.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawBody) as JsonValue;
  } catch {
    return null;
  }
}

function parsePayloadBody(body: JsonValue | null): CapturedLogPayload | null {
  if (!isRecord(body) || !Array.isArray(body.rows)) {
    return null;
  }

  return {
    api_version: typeof body.api_version === "number" ? body.api_version : 0,
    rows: body.rows.reduce<CapturedLogRow[]>((capturedRows, row) => {
      if (isRecord(row)) {
        capturedRows.push(clone(row));
      }
      return capturedRows;
    }, []),
  };
}

function parsePayload(request: CapturedRequest): CapturedLogPayload | null {
  return parsePayloadBody(request.jsonBody);
}

function rowKey(row: CapturedLogRow): string {
  return JSON.stringify(
    [
      "org_id",
      "project_id",
      "experiment_id",
      "dataset_id",
      "prompt_session_id",
      "log_id",
      "id",
    ].map((key) => row[key]),
  );
}

function mergeValue(base: unknown, incoming: unknown): unknown {
  if (isRecord(base) && isRecord(incoming)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }

  return incoming;
}

function mergeRow(
  existing: CapturedLogRow | undefined,
  incoming: CapturedLogRow,
): CapturedLogRow {
  if (!existing || !incoming._is_merge) {
    return clone(incoming);
  }

  const preserveNoMerge = !existing._is_merge;
  const merged = mergeValue(existing, incoming) as CapturedLogRow;
  if (preserveNoMerge) {
    delete merged._is_merge;
  }
  return clone(merged);
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? clone(value) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function toCapturedLogEvent(
  apiVersion: number,
  row: CapturedLogRow,
  rawRow: CapturedLogRow,
): CapturedLogEvent {
  const spanAttributes = recordField(row.span_attributes);
  const metrics = recordField(row.metrics);

  return {
    apiVersion,
    context: recordField(row.context),
    expected: clone(row.expected),
    experimentId: stringField(row.experiment_id),
    input: clone(row.input),
    isMerge: rawRow._is_merge === true,
    metadata: recordField(row.metadata),
    metrics,
    output: clone(row.output),
    projectId: stringField(row.project_id),
    row: clone(row),
    scores: clone(row.scores),
    span: {
      ended: typeof metrics?.end === "number",
      id: stringField(row.span_id),
      name: stringField(spanAttributes?.name),
      parentIds: arrayOfStrings(row.span_parents),
      rootId: stringField(row.root_span_id),
      started: typeof metrics?.start === "number",
      type: stringField(spanAttributes?.type),
    },
  };
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function capturedRequestFrom(
  method: string | undefined,
  requestUrl: URL,
  headers: IncomingHttpHeaders,
  rawBody: string,
): CapturedRequest {
  return {
    method: method ?? "GET",
    path: requestUrl.pathname,
    query: Object.fromEntries(requestUrl.searchParams.entries()),
    headers: normalizeHeaders(headers),
    rawBody,
    jsonBody: parseJson(rawBody),
  };
}

export async function startMockBraintrustServer(
  apiKey = DEFAULT_API_KEY,
): Promise<MockBraintrustServer> {
  const requests: CapturedRequest[] = [];
  const payloads: CapturedLogPayload[] = [];
  const events: CapturedLogEvent[] = [];
  const mergedRows = new Map<string, CapturedLogRow>();
  const projectsByName = new Map<string, { id: string; name: string }>();
  let serverUrl = "";
  let xactCursor = 0;

  function nextXactId(): string {
    xactCursor += 1;
    return String(xactCursor).padStart(12, "0");
  }

  function persistPayload(payload: CapturedLogPayload): void {
    payloads.push(payload);

    for (const row of payload.rows) {
      const persistedRow = clone(row);
      if (typeof persistedRow._xact_id !== "string") {
        persistedRow._xact_id = nextXactId();
      }

      const key = rowKey(persistedRow);
      const mergedRow = mergeRow(mergedRows.get(key), persistedRow);
      mergedRows.set(key, mergedRow);
      events.push(
        toCapturedLogEvent(payload.api_version, mergedRow, persistedRow),
      );
    }
  }

  function projectForName(name: string): { id: string; name: string } {
    const existing = projectsByName.get(name);
    if (existing) {
      return existing;
    }

    const created = { id: randomUUID(), name };
    projectsByName.set(name, created);
    return created;
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const requestUrl = new URL(
          req.url ?? "/",
          serverUrl || "http://127.0.0.1",
        );
        const rawBody = await readRequestBody(req);
        const capturedRequest = capturedRequestFrom(
          req.method,
          requestUrl,
          req.headers,
          rawBody,
        );

        requests.push(capturedRequest);

        if (
          capturedRequest.method === "POST" &&
          capturedRequest.path === "/api/apikey/login"
        ) {
          respondJson(res, 200, {
            org_info: [
              {
                id: "mock-org-id",
                name: "mock-org",
                api_url: serverUrl,
                proxy_url: serverUrl,
              },
            ],
          });
          return;
        }

        if (
          capturedRequest.method === "POST" &&
          capturedRequest.path === "/api/project/register"
        ) {
          const projectName =
            isRecord(capturedRequest.jsonBody) &&
            typeof capturedRequest.jsonBody.project_name === "string"
              ? capturedRequest.jsonBody.project_name
              : "project";

          respondJson(res, 200, {
            project: projectForName(projectName),
          });
          return;
        }

        if (
          capturedRequest.method === "GET" &&
          capturedRequest.path === "/version"
        ) {
          respondJson(res, 200, {});
          return;
        }

        if (
          capturedRequest.method === "POST" &&
          capturedRequest.path === "/logs3"
        ) {
          const payload = parsePayload(capturedRequest);
          if (payload) {
            persistPayload(payload);
          }
          respondJson(res, 200, { ok: true });
          return;
        }

        if (
          capturedRequest.method === "POST" &&
          capturedRequest.path === "/otel/v1/traces"
        ) {
          respondJson(res, 200, { ok: true });
          return;
        }

        respondJson(res, 404, {
          error: `Unhandled mock Braintrust route: ${capturedRequest.method} ${capturedRequest.path}`,
        });
      } catch (error) {
        respondJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  serverUrl = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    apiKey,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    events,
    payloads,
    requests,
    url: serverUrl,
  };
}
