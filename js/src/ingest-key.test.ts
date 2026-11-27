import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { inspect } from "node:util";
import {
  Attachment,
  BraintrustState,
  extractTraceContextFromHeaders,
  initLogger,
  loginToState,
  _internalStartSpan,
  updateSpan,
} from "./logger/core";
import { configureNode } from "./node/config";
import iso from "#braintrust-platform";
import { TypedAttachmentProcessor } from "./typed-attachments";
import { parseIngestKey, INGEST_KEY_ATTACHMENT_BLOCKED } from "./ingest-key";
import { SpanComponentsV4 } from "../util/span_identifier_v4";

configureNode();
const key = "https://bt-ik-test-secret@ingest.test/prefix/logs3";

function setup(apiKey = key, setCurrent = true) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/apikey/login")
      return Response.json({
        org_info: [
          { id: "org", name: "org", api_url: "https://ordinary.test" },
        ],
      });
    if (path === "/api/project/register")
      return Response.json({ project: { id: "project", name: "project" } });
    return Response.json({});
  });
  const onFlushError = vi.fn();
  const state = new BraintrustState({
    apiKey,
    fetch,
    noExitFlush: true,
    onFlushError,
  });
  state.httpLogger().syncFlush = true;
  state.httpLogger().numTries = 1;
  const logger = initLogger({
    state,
    setCurrent,
    projectName: "ignored",
    projectId: "ignored-id",
  });
  return { state, logger, fetch, onFlushError };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ingest key configuration", () => {
  test("extracts a token and the complete endpoint", () => {
    expect(parseIngestKey(` ${key} `)).toEqual({
      token: "bt-ik-test-secret",
      endpoint: "https://ingest.test/prefix/logs3",
    });
    expect(parseIngestKey("ordinary-key")).toBeUndefined();
    expect(parseIngestKey("eyJ.token.jwt")).toBeUndefined();
  });
  test.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows loopback HTTP: %s",
    (host) => {
      expect(
        parseIngestKey(`http://bt-ik-test@${host}:1234/logs3`)?.endpoint,
      ).toBe(`http://${host}:1234/logs3`);
    },
  );
  test.each([
    "bt-ik-secret",
    "https://bt-ik-secret@",
    "http://bt-ik-secret@remote.test/logs3",
    "https://bt-ik-secret:password@host.test/logs3",
    "https://bt-ik-secret@host.test/logs3?q=secret",
    "https://bt-ik-secret@host.test/logs3#secret",
    "https://wrong-secret@host.test/logs3",
    "https://bt-ik-secret@host.test/",
  ])("rejects malformed configuration without exposing it: %s", (value) => {
    expect(() => parseIngestKey(value)).toThrow("Invalid ingest key");
    try {
      parseIngestKey(value);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
  test("uses the environment credential without discovery", async () => {
    vi.stubEnv("BRAINTRUST_API_KEY", key);
    vi.stubEnv("BRAINTRUST_API_URL", "https://wrong.test");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    const state = await loginToState({ fetch, noExitFlush: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.apiUrl).toBe("https://ingest.test/prefix/logs3");
    expect(JSON.stringify(state)).not.toContain("bt-ik-");
    expect(inspect(state)).not.toContain("bt-ik-");
  });
});

test("logs without login, project metadata, or version requests", async () => {
  const { state, logger, fetch, onFlushError } = setup();
  await Promise.all(Array.from({ length: 10 }, () => logger.id));
  expect(await logger.id).toBeUndefined();
  expect(await logger.project).toBeUndefined();
  expect(await logger.org_id).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  const root = logger.startSpan({ name: "root", event: { input: "question" } });
  const child = root.startSpan({ name: "child", event: { output: "answer" } });
  child.end();
  root.end();
  await logger.flush();
  expect(onFlushError).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, request] = fetch.mock.calls[0];
  expect(url).toBe("https://ingest.test/prefix/logs3");
  expect(request?.headers).toMatchObject({
    Authorization: "Bearer bt-ik-test-secret",
  });
  expect(request?.redirect).toBe("error");
  const rows = JSON.parse(String(request?.body)).rows;
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (row: Record<string, unknown>) =>
        row.project_id === undefined && row.log_id === "g",
    ),
  ).toBe(true);
  expect(
    rows.find((row: { id: string }) => row.id === child.id).span_parents,
  ).toEqual([root.spanId]);
  expect(state.serialize.bind(state)).toThrow("cannot be serialized");
});

test.each([true, false])(
  "exports and continues traces without a project (setCurrent=%s)",
  async (setCurrent) => {
    const source = setup(key, setCurrent);
    const root = source.logger.startSpan({ name: "source" });
    const slug = await root.export();
    const exported = SpanComponentsV4.fromStr(slug).data;
    expect(exported.object_id).toBeUndefined();
    expect(exported.compute_object_metadata_args).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain("bt-ik-");
    expect(
      SpanComponentsV4.fromStr(await source.logger.export()).data.object_id,
    ).toBeUndefined();
    root.end();
    await source.logger.flush();
    expect(await root.export()).toBe(slug);

    const receiver = setup(key, setCurrent);
    const child = receiver.logger.startSpan({
      // @ts-expect-error Legacy parent strings remain supported at runtime.
      parent: slug,
      name: "legacy-child",
    });
    expect(child.rootSpanId).toBe(root.rootSpanId);
    child.end();
    const headers = root.inject();
    expect(headers.baggage).toBeUndefined();
    const w3cChild = receiver.logger.startSpan({
      parent: extractTraceContextFromHeaders(headers),
      name: "w3c-child",
    });
    expect(w3cChild.rootSpanId).toBe(root.rootSpanId);
    w3cChild.end();
    receiver.logger.updateSpan({ id: child.id, output: "updated" });
    updateSpan({
      state: receiver.state,
      exported: slug,
      output: "remote update",
    });
    await receiver.logger.flush();
    expect(receiver.onFlushError).not.toHaveBeenCalled();
    expect(
      receiver.fetch.mock.calls.every(
        ([url]) => String(url) === "https://ingest.test/prefix/logs3",
      ),
    ).toBe(true);
  },
);

test("receives exported parents through the global tracing API", async () => {
  const source = setup();
  const root = source.logger.startSpan({ name: "root" });
  const receiver = setup();
  const child = _internalStartSpan({
    state: receiver.state,
    parent: await root.export(),
    name: "remote",
  });
  expect(child.rootSpanId).toBe(root.rootSpanId);
  child.end();
  root.end();
  await Promise.all([source.logger.flush(), receiver.logger.flush()]);
  expect(receiver.onFlushError).not.toHaveBeenCalled();
});

test("an ordinary API-key receiver supplies its own project", async () => {
  const source = setup();
  const root = source.logger.startSpan({ name: "root" });
  const receiver = setup("ordinary-key");
  const child = _internalStartSpan({
    state: receiver.state,
    parent: await root.export(),
    name: "remote",
  });
  child.end();
  root.end();
  await Promise.all([source.logger.flush(), receiver.logger.flush()]);
  expect(receiver.onFlushError).not.toHaveBeenCalled();
  const request = receiver.fetch.mock.calls.find(([url]) =>
    String(url).endsWith("/logs3"),
  );
  expect(JSON.parse(String(request?.[1]?.body)).rows[0].project_id).toBe(
    "ignored-id",
  );
});

test("blocks attachments after masking without uploading them", async () => {
  const { logger, state, fetch, onFlushError } = setup();
  const attachment = new Attachment({
    data: new Blob(["data"]),
    filename: "data.txt",
    contentType: "text/plain",
    state,
  });
  const upload = vi.spyOn(attachment, "upload");
  state.setMaskingFunction((value) => (value === "private" ? "masked" : value));
  logger.log({
    input: {
      attachment,
      nested: [
        {
          type: "external_attachment",
          url: "https://private.test",
          content_type: "image/png",
        },
      ],
    },
    output: "private",
  });
  await logger.flush();
  expect(onFlushError).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  const row = JSON.parse(String(fetch.mock.calls[0][1]?.body)).rows[0];
  expect(row.input).toEqual({
    attachment: INGEST_KEY_ATTACHMENT_BLOCKED,
    nested: [INGEST_KEY_ATTACHMENT_BLOCKED],
  });
  expect(row.output).toBe("masked");
  await expect(attachment.upload()).rejects.toThrow(
    "do not support attachment uploads",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("rejects oversized rows without requesting an overflow upload", async () => {
  vi.stubEnv("BRAINTRUST_MAX_REQUEST_SIZE", "1024");
  const { logger, fetch, onFlushError } = setup();
  logger.log({ input: "x".repeat(2048) });
  await logger.flush();
  expect(fetch).not.toHaveBeenCalled();
  expect(onFlushError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("overflow uploads are not supported"),
    }),
  );
});

test("rejects unsupported operations without network calls", async () => {
  const { state, logger, fetch } = setup();
  await logger.id;
  expect(() => state.appConn()).toThrow("only send project logs");
  expect(() => state.proxyConn()).toThrow("cannot call the model proxy");
  await expect(state.apiConn().get("version")).rejects.toThrow(
    "only send project logs",
  );
  await expect(state.apiConn().post("attachment", {})).rejects.toThrow(
    "only send project logs",
  );
  await expect(state._internalResolveLoaderLoginOptions({})).rejects.toThrow(
    "cannot load prompts",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("forced login changes credentials and resets transport capabilities", async () => {
  const { state, logger, fetch, onFlushError } = setup();
  logger.log({ input: "ingest" });
  await logger.flush();
  await state.login({ apiKey: "ordinary-key", forceLogin: true });
  const ordinary = initLogger({
    state,
    projectId: "project",
    projectName: "project",
  });
  ordinary.log({ input: "ordinary" });
  await ordinary.flush();
  expect(
    fetch.mock.calls.some(
      ([url]) => String(url) === "https://ordinary.test/version",
    ),
  ).toBe(true);
  await state.login({
    apiKey: "https://bt-ik-second@second.test/custom/path",
    forceLogin: true,
  });
  const second = initLogger({ state });
  second.log({ input: "second" });
  await second.flush();
  expect(fetch.mock.calls.at(-1)?.[0]).toBe("https://second.test/custom/path");
  expect(onFlushError).not.toHaveBeenCalled();
});

test("resolves file credentials before exporting project context", async () => {
  vi.stubEnv("BRAINTRUST_API_KEY", "");
  vi.spyOn(iso, "getBraintrustApiKey").mockResolvedValue(key);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
  const state = new BraintrustState({ fetch, noExitFlush: true });
  state.httpLogger().syncFlush = true;
  const logger = initLogger({ state, projectName: "ignored-file-project" });
  const span = logger.startSpan({ name: "file-key" });
  expect(
    SpanComponentsV4.fromStr(await span.export()).data
      .compute_object_metadata_args,
  ).toBeUndefined();
  expect(
    SpanComponentsV4.fromStr(await logger.export()).data
      .compute_object_metadata_args,
  ).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  span.end();
  await logger.flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("https://ingest.test/prefix/logs3");
});

test("uses a replacement fetch and skips automatic media uploads", async () => {
  const { state, logger, fetch, onFlushError } = setup();
  await logger.id;
  const replacement = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({}),
  );
  state.setFetch(replacement);
  const process = vi.spyOn(TypedAttachmentProcessor.prototype, "process");
  logger.log({ input: { state: "data:image/png;base64,aGVsbG8=" } });
  await logger.flush();
  expect(process).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(replacement).toHaveBeenCalledTimes(1);
  expect(onFlushError).not.toHaveBeenCalled();
});

test("batches multi-byte payloads using byte lengths without overflow", async () => {
  vi.stubEnv("BRAINTRUST_MAX_REQUEST_SIZE", "4000");
  const { logger, fetch, onFlushError } = setup();
  for (let i = 0; i < 5; i++) logger.log({ input: "🐱".repeat(500) });
  await logger.flush();
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(onFlushError).not.toHaveBeenCalled();
  for (const [, request] of fetch.mock.calls)
    expect(new TextEncoder().encode(String(request?.body)).length).toBeLessThan(
      4000,
    );
});

test("ingest-key receivers do not forward inbound project routing", async () => {
  const source = setup("ordinary-key");
  const root = source.logger.startSpan({ name: "ordinary-root" });
  const receiver = setup();
  const remote = _internalStartSpan({
    state: receiver.state,
    parent: extractTraceContextFromHeaders(root.inject()),
    name: "ingest-root",
  });
  expect(remote.rootSpanId).toBe(root.rootSpanId);
  expect(remote.inject().baggage).toBeUndefined();
  root.end();
  remote.end();
  await Promise.all([source.logger.flush(), receiver.logger.flush()]);
  expect(receiver.onFlushError).not.toHaveBeenCalled();
});

test("export waits for a forced switch to an ingest key", async () => {
  const { state, logger, fetch } = setup("ordinary-key");
  await logger.id;
  const next = initLogger({
    state,
    apiKey: key,
    forceLogin: true,
    projectId: "ignored",
    projectName: "ignored",
  });
  expect(
    SpanComponentsV4.fromStr(await next.export()).data.object_id,
  ).toBeUndefined();
  expect(
    SpanComponentsV4.fromStr(await next.export()).data
      .compute_object_metadata_args,
  ).toBeUndefined();
  next.log({ input: "after switch" });
  await next.flush();
  expect(fetch.mock.calls.at(-1)?.[0]).toBe("https://ingest.test/prefix/logs3");
});
