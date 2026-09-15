import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";
import {
  _exportsForTestingOnly,
  BraintrustState,
  initLogger,
  type TestBackgroundLogger,
} from "./logger";
import { configureInstrumentation, registry } from "./instrumentation/registry";
import { configureNode } from "./node/config";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "./span-origin";
import type { SpanCustomizer, SpanExportData } from "./exports";
import { customizeSpanExport } from "./span-customizer";

configureNode();

test("customizers expose only the outgoing-record export hook", () => {
  expectTypeOf<SpanCustomizer>().toEqualTypeOf<{
    onSpanExport?(data: SpanExportData): SpanExportData;
  }>();
});

describe("onSpanExport", () => {
  let memoryLogger: TestBackgroundLogger;

  beforeEach(async () => {
    registry.disable();
    await _exportsForTestingOnly.simulateLoginForTests();
    memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    configureInstrumentation({ spanCustomizers: [] });
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.unstubAllEnvs();
  });

  function startInstrumentedSpan() {
    return initLogger({
      projectName: "customizer-project",
      projectId: "customizer-project",
    }).startSpan(
      withSpanInstrumentationName(
        { name: "provider.call" },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    );
  }

  test("adds a field to outgoing span records", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            data.custom_field = "added";
            return data;
          },
        },
      ],
    });

    const span = startInstrumentedSpan();
    span.log({ output: "result" });
    span.end();

    const events = await memoryLogger.drain();
    expect(events).toEqual([
      expect.objectContaining({
        id: span.id,
        project_id: "customizer-project",
        output: "result",
        custom_field: "added",
      }),
    ]);
  });

  test("alters an existing field in outgoing span records", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            if ("output" in data) data.output = "[redacted]";
            return data;
          },
        },
      ],
    });

    const span = startInstrumentedSpan();
    span.log({ output: "sensitive response" });
    span.end();

    expect(await memoryLogger.drain()).toEqual([
      expect.objectContaining({ id: span.id, output: "[redacted]" }),
    ]);
  });

  test("deletes a field from outgoing span records", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            delete data.error;
            return data;
          },
        },
      ],
    });

    const span = startInstrumentedSpan();
    span.log({ error: "sensitive error", output: "safe response" });
    span.end();

    const events = await memoryLogger.drain();
    expect(events).toEqual([
      expect.objectContaining({ id: span.id, output: "safe response" }),
    ]);
    expect(events[0]).not.toHaveProperty("error");
  });

  test("passes replacement records through later customizers despite errors", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            return "output" in data ? { ...data, output: "replacement" } : data;
          },
        },
        {
          onSpanExport() {
            throw new Error("customizer failed");
          },
        },
        {
          onSpanExport(data) {
            if (typeof data.output === "string") {
              data.output = data.output.toUpperCase();
            }
            return data;
          },
        },
      ],
    });

    const span = startInstrumentedSpan();
    span.log({ output: "original" });
    span.end();

    expect(await memoryLogger.drain()).toEqual([
      expect.objectContaining({
        id: span.id,
        output: "REPLACEMENT",
        metrics: expect.objectContaining({ end: expect.any(Number) }),
      }),
    ]);
  });

  test("does not customize manually created spans", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            data.tags = ["customized"];
            return data;
          },
        },
      ],
    });

    const instrumented = startInstrumentedSpan();
    const manual = instrumented.startSpan({ name: "manual child" });
    manual.log({ output: "manual result" });
    manual.end();
    instrumented.end();

    const events = await memoryLogger.drain();
    expect(events.find((event) => event.id === instrumented.id)).toMatchObject({
      tags: ["customized"],
    });
    const manualEvent = events.find((event) => event.id === manual.id);
    expect(manualEvent).toMatchObject({ output: "manual result" });
    expect(manualEvent).not.toHaveProperty("tags");
  });

  test.each([
    ["missing return", () => undefined],
    ["null", () => null],
    ["array", () => []],
    ["scalar", () => "invalid"],
    ["non-record object", () => new Date(0)],
  ])("ignores %s without losing either span", async (_name, invalidResult) => {
    configureInstrumentation({
      spanCustomizers: [
        {
          // @ts-expect-error Exercise invalid callback results from JavaScript.
          onSpanExport(data) {
            if ("output" in data) data.output = "redacted";
            return invalidResult();
          },
        },
        {
          onSpanExport(data) {
            if ("output" in data) data.output = `${data.output}:processed`;
            return data;
          },
        },
      ],
    });
    const span = startInstrumentedSpan();
    const manual = span.startSpan({ name: "manual" });
    span.log({ input: "input", output: "private" });
    manual.log({ output: "unrelated" });
    manual.end();
    span.end();

    const events = await memoryLogger.drain();
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.id === span.id)).toMatchObject({
      input: "input",
      output: "redacted:processed",
      metrics: { end: expect.any(Number) },
    });
    expect(events.find((event) => event.id === manual.id)).toMatchObject({
      output: "unrelated",
      metrics: { end: expect.any(Number) },
    });
  });

  test("restores mutable protocol fields between callbacks, even after a throw", () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            if (Array.isArray(data.span_parents))
              data.span_parents.push("wrong");
            if (Array.isArray(data._merge_paths))
              data._merge_paths[0].push("wrong");
            delete data.id;
            delete data.project_id;
            data._is_merge = false;
            data.dataset_id = "wrong";
            data._object_delete = true;
            throw new Error("bad customizer");
          },
        },
        {
          onSpanExport(data) {
            // These fields feed the next callback, not just the final exporter.
            data.output = {
              id: data.id,
              parents: data.span_parents,
              paths: data._merge_paths,
              merge: data._is_merge,
            };
            return Object.freeze(data);
          },
        },
      ],
    });
    const result = customizeSpanExport({
      id: "original",
      span_id: "span",
      root_span_id: "root",
      span_parents: ["parent"],
      project_id: "project",
      log_id: "g",
      _is_merge: true,
      _merge_paths: [["metadata"]],
    });
    expect(result).toEqual({
      id: "original",
      span_id: "span",
      root_span_id: "root",
      span_parents: ["parent"],
      project_id: "project",
      log_id: "g",
      _is_merge: true,
      _merge_paths: [["metadata"]],
      output: {
        id: "original",
        parents: ["parent"],
        paths: [["metadata"]],
        merge: true,
      },
    });
  });

  test("exports a mixed HTTP batch despite async hooks and payload-only replacements", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          // @ts-expect-error Async customizers are unsupported, but must be contained.
          async onSpanExport(data) {
            delete data.id;
            delete data._is_merge;
            if ("output" in data) data.output = "redacted";
            throw new Error("async customizer failed");
          },
        },
        {
          onSpanExport(data) {
            const payload = Object.fromEntries(
              Object.entries(data).filter(([key]) =>
                ["input", "output", "metrics", "span_attributes"].includes(key),
              ),
            );
            return Object.freeze(payload);
          },
        },
      ],
    });

    // Keep both spans in the same flush chunk, rather than auto-flushing the
    // manual span's initial row before the instrumented child is created.
    vi.stubEnv("BRAINTRUST_SYNC_FLUSH", "1");
    const rows: Record<string, unknown>[] = [];
    const state = new BraintrustState({ noExitFlush: true });
    const logger = initLogger({
      state,
      projectName: "customizer-project",
      projectId: "customizer-project",
      appUrl: "https://customizer.test",
      apiKey: "test-key",
      orgName: "test-org",
      asyncFlush: false,
      fetch: async (url, options) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === "/api/apikey/login") {
          return Response.json({
            org_info: [
              {
                id: "test-org",
                name: "test-org",
                api_url: "https://customizer.test",
              },
            ],
          });
        }
        if (pathname === "/version") return Response.json({});
        if (pathname === "/logs3") {
          rows.push(...JSON.parse(String(options?.body)).rows);
          return Response.json({});
        }
        throw new Error(`Unexpected test request: ${pathname}`);
      },
    });
    const manual = logger.startSpan({
      name: "manual",
      event: { input: "manual input" },
    });
    const span = manual.startSpan(
      withSpanInstrumentationName(
        { name: "provider", event: { input: "provider input" } },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    );
    span.log({ output: "private" });
    span.end();
    manual.log({ output: "manual output" });
    manual.end();
    await logger.flush();

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === span.id)).toMatchObject({
      span_id: span.spanId,
      root_span_id: manual.rootSpanId,
      span_parents: [manual.spanId],
      project_id: "customizer-project",
      log_id: "g",
      input: "provider input",
      output: "redacted",
      metrics: { start: expect.any(Number), end: expect.any(Number) },
    });
    expect(rows.find((row) => row.id === manual.id)).toMatchObject({
      input: "manual input",
      output: "manual output",
      metrics: { start: expect.any(Number), end: expect.any(Number) },
    });
  });
});
