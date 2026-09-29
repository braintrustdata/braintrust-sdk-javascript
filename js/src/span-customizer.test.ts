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
  _internalGetGlobalState,
  Attachment,
  BraintrustState,
  Dataset,
  initLogger,
  SpanImpl,
  updateSpan,
  type TestBackgroundLogger,
} from "./logger";
import { configureInstrumentation, registry } from "./instrumentation/registry";
import { configureNode } from "./node/config";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "./span-origin";
import vm from "node:vm";
import type { SpanCustomizer, SpanExportData } from "./exports";
import {
  customizeSpanExport,
  resetSpanCustomizerFailureLoggingForTests,
} from "./span-customizer";
import { SpanCache } from "./span-cache";
import { LazyValue } from "./util";
import { SpanObjectTypeV3 } from "../util";

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
    resetSpanCustomizerFailureLoggingForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  test("passes replacement records through later customizers", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            return "output" in data ? { ...data, output: "replacement" } : data;
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

  test("customizes manual roots and children as well as instrumented spans", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            data.tags = ["customized"];
            if ("output" in data) data.output = "[redacted]";
            return data;
          },
        },
      ],
    });

    const root = initLogger({
      projectName: "customizer-project",
      projectId: "customizer-project",
    }).startSpan({ name: "manual root" });
    const instrumented = root.startSpan(
      withSpanInstrumentationName(
        { name: "provider.call" },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    );
    const manual = instrumented.startSpan({ name: "manual child" });
    manual.log({ output: "manual result" });
    manual.end();
    instrumented.end();
    root.log({ output: "root result" });
    root.end();

    const events = await memoryLogger.drain();
    expect(events).toHaveLength(3);
    expect(events.find((event) => event.id === root.id)).toMatchObject({
      output: "[redacted]",
      tags: ["customized"],
      context: {
        span_origin: {
          instrumentation: { name: INSTRUMENTATION_NAMES.BRAINTRUST_JS_LOGGER },
        },
      },
    });
    expect(events.find((event) => event.id === instrumented.id)).toMatchObject({
      tags: ["customized"],
      span_parents: [root.spanId],
      context: {
        span_origin: {
          instrumentation: { name: INSTRUMENTATION_NAMES.OPENAI },
        },
      },
    });
    expect(events.find((event) => event.id === manual.id)).toMatchObject({
      output: "[redacted]",
      tags: ["customized"],
      span_parents: [instrumented.spanId],
      context: {
        span_origin: {
          instrumentation: { name: INSTRUMENTATION_NAMES.BRAINTRUST_JS_LOGGER },
        },
      },
    });
  });

  test("customizes logger and experiment logs but not dataset rows or feedback", async () => {
    const onSpanExport = vi.fn((data: SpanExportData) => {
      if ("output" in data) data.output = "[redacted]";
      if ("expected" in data) data.expected = "[redacted]";
      data.tags = ["customized"];
      return data;
    });
    configureInstrumentation({ spanCustomizers: [{ onSpanExport }] });
    const logger = initLogger({
      projectName: "customizer-project",
      projectId: "customizer-project",
    });
    const experiment = _exportsForTestingOnly.initTestExperiment(
      "customizer-experiment",
      "customizer-project",
    );
    const logId = await logger.log({ output: "logger result" });
    const experimentId = experiment.log({
      input: "input",
      output: "experiment result",
      expected: "experiment expected",
      scores: { quality: 1 },
    });

    expect(await memoryLogger.drain()).toEqual([
      expect.objectContaining({
        id: logId,
        project_id: "customizer-project",
        output: "[redacted]",
        tags: ["customized"],
      }),
      expect.objectContaining({
        id: experimentId,
        experiment_id: "customizer-experiment",
        output: "[redacted]",
        expected: "[redacted]",
        tags: ["customized"],
      }),
    ]);

    onSpanExport.mockClear();
    const dataset = new Dataset(
      experiment.loggingState,
      new LazyValue(async () => ({
        project: {
          id: "customizer-project",
          name: "customizer-project",
          fullInfo: {},
        },
        dataset: {
          id: "customizer-dataset",
          name: "customizer-dataset",
          fullInfo: {},
        },
      })),
      undefined,
      false,
    );
    const datasetId = dataset.insert({
      input: "dataset input",
      expected: "dataset expected",
      tags: ["dataset"],
    });
    logger.logFeedback({
      id: logId,
      expected: "logger feedback",
      tags: ["feedback"],
      comment: "review",
    });
    experiment.logFeedback({
      id: experimentId,
      expected: "experiment feedback",
      tags: ["feedback"],
    });

    expect(await memoryLogger.drain()).toEqual([
      expect.objectContaining({
        id: datasetId,
        dataset_id: "customizer-dataset",
        input: "dataset input",
        expected: "dataset expected",
        tags: ["dataset"],
      }),
      expect.objectContaining({
        id: logId,
        expected: "logger feedback",
        tags: ["feedback"],
      }),
      expect.objectContaining({
        origin: { id: logId },
        comment: { text: "review" },
      }),
      expect.objectContaining({
        id: experimentId,
        expected: "experiment feedback",
        tags: ["feedback"],
      }),
    ]);
    expect(onSpanExport).not.toHaveBeenCalled();
  });

  test.each(["logger", "experiment", "exported"] as const)(
    "customizes %s updateSpan records before merging and excludes feedback",
    async (entrypoint) => {
      const parent =
        entrypoint === "experiment"
          ? _exportsForTestingOnly.initTestExperiment(
              "customizer-experiment",
              "customizer-project",
            )
          : initLogger({
              projectName: "customizer-project",
              projectId: "customizer-project",
            });
      const span = parent.startSpan({ name: "update target" });
      const exported = await span.export();
      span.end();
      await memoryLogger.drain();

      const update = (event: {
        output: unknown;
        input?: unknown;
        metadata?: Record<string, unknown>;
      }) => {
        if (entrypoint === "exported") {
          updateSpan({ exported, ...event });
        } else if (entrypoint === "logger") {
          parent.updateSpan({
            id: span.id,
            span_id: span.spanId,
            root_span_id: span.rootSpanId,
            ...event,
          });
        } else {
          parent.updateSpan({ id: span.id, ...event });
        }
      };
      const onSpanExport = vi.fn((data: SpanExportData) => {
        if (data.output === "private") {
          throw new Error("private update detail");
        }
        return {
          output: "[redacted]",
          metadata: { safe: true },
          id: "wrong",
          project_id: "wrong",
          experiment_id: "wrong",
          _is_merge: false,
        };
      });
      configureInstrumentation({ spanCustomizers: [{ onSpanExport }] });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      update({ output: "sensitive", metadata: { secret: "sensitive" } });

      const attachment = new Attachment({
        data: new ArrayBuffer(1),
        filename: "private.txt",
        contentType: "text/plain",
      });
      const attachmentUpload = vi.spyOn(attachment, "upload");
      const enqueue = vi.spyOn(memoryLogger, "log");
      update({ output: "private", input: attachment });
      const droppedRecords = enqueue.mock.calls.flatMap(([items]) => items);

      // A rejected update cannot overwrite the preceding safe update.
      const events = await memoryLogger.drain();
      expect(events).toEqual([
        {
          id: span.id,
          ...(entrypoint === "experiment"
            ? { experiment_id: "customizer-experiment" }
            : { project_id: "customizer-project", log_id: "g" }),
          ...(entrypoint === "experiment"
            ? {}
            : { span_id: span.spanId, root_span_id: span.rootSpanId }),
          _is_merge: true,
          output: "[redacted]",
          metadata: { safe: true },
        },
      ]);
      expect(onSpanExport).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private");

      const fetch = vi.fn<typeof globalThis.fetch>();
      const state = new BraintrustState({ noExitFlush: true, fetch });
      const httpLogger = state.httpLogger();
      httpLogger.syncFlush = true;
      httpLogger.log(droppedRecords);
      await httpLogger.flush();
      httpLogger.log(droppedRecords);
      await httpLogger.flush();
      expect(fetch).not.toHaveBeenCalled();
      expect(attachmentUpload).not.toHaveBeenCalled();
      expect(onSpanExport).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledTimes(1);

      parent.logFeedback({
        id: span.id,
        expected: "unmodified feedback",
        comment: "unmodified comment",
      });
      expect(await memoryLogger.drain()).toEqual([
        expect.objectContaining({
          id: span.id,
          expected: "unmodified feedback",
        }),
        expect.objectContaining({
          origin: { id: span.id },
          comment: { text: "unmodified comment" },
        }),
      ]);
      expect(onSpanExport).toHaveBeenCalledTimes(2);

      update({ output: "recovered" });
      expect(await memoryLogger.drain()).toEqual([
        expect.objectContaining({ id: span.id, output: "[redacted]" }),
      ]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    },
  );

  test.each<[string, () => unknown]>([
    [
      "throw",
      () => {
        throw new Error("private exception detail");
      },
    ],
    ["missing return", () => undefined],
    ["null", () => null],
    ["array", () => []],
    ["scalar", () => "invalid"],
    ["non-record object", () => new Date(0)],
    ["class instance", () => new (class Replacement {})()],
    ["inherited object", () => Object.create({ output: "inherited" })],
  ])(
    "drops the failing record on %s and stops its callback chain",
    async (_name, invalidResult) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const laterHook = vi.fn((data: SpanExportData) => data);
      configureInstrumentation({
        spanCustomizers: [
          {
            // @ts-expect-error Exercise invalid callback results from JavaScript.
            onSpanExport(data) {
              if (data.output === "private") return invalidResult();
              return data;
            },
          },
          { onSpanExport: laterHook },
        ],
      });
      const span = startInstrumentedSpan();
      span.log({ output: "private" });
      const manual = span.startSpan({ name: "manual" });
      manual.log({ output: "unrelated" });
      manual.end();

      const events = await memoryLogger.drain();
      expect(events).toHaveLength(2);
      expect(events.find((event) => event.id === span.id)).not.toHaveProperty(
        "output",
      );
      expect(events.find((event) => event.id === manual.id)).toMatchObject({
        output: "unrelated",
        metrics: { end: expect.any(Number) },
      });
      expect(
        laterHook.mock.calls.some(([data]) => data.output === "private"),
      ).toBe(false);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private");
      expect(
        errorLog.mock.calls[0].every((value) => typeof value === "string"),
      ).toBe(true);

      // Dropping one incremental record does not disable its logical span.
      span.log({ output: "recovered" });
      span.end();
      expect(await memoryLogger.drain()).toEqual([
        expect.objectContaining({ id: span.id, output: "recovered" }),
      ]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    },
  );

  test("restores mutable protocol fields between successful callbacks", () => {
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
            return data;
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

  test("memoizes dropped records across repeated flushes without uploading empty batches", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSpanExport = vi.fn(() => {
      throw new Error("private failure");
    });
    const laterHook = vi.fn((data: SpanExportData) => data);
    configureInstrumentation({
      spanCustomizers: [{ onSpanExport }, { onSpanExport: laterHook }],
    });
    const enqueue = vi.spyOn(memoryLogger, "log");
    startInstrumentedSpan();
    const records = enqueue.mock.calls.flatMap(([items]) => items);
    expect(await memoryLogger.drain()).toEqual([]);
    const failureCount = onSpanExport.mock.calls.length;
    expect(failureCount).toBeGreaterThan(0);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const fetch = vi.fn<typeof globalThis.fetch>();
    const state = new BraintrustState({ noExitFlush: true, fetch });
    const httpLogger = state.httpLogger();
    httpLogger.syncFlush = true;
    httpLogger.log(records);
    await httpLogger.flush();
    httpLogger.log(records);
    await httpLogger.flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(onSpanExport).toHaveBeenCalledTimes(failureCount);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(laterHook).not.toHaveBeenCalled();
  });

  test("accepts null-prototype and cross-realm plain replacements", () => {
    const crossRealm = vm.runInNewContext(
      "({ output: 'vm', metadata: { nested: ['value'] } })",
    );
    expect(Object.getPrototypeOf(crossRealm)).not.toBe(Object.prototype);
    const nullPrototype = Object.assign(Object.create(null), {
      output: "null prototype",
    });
    for (const [replacement, output] of [
      [nullPrototype, "null prototype"],
      [crossRealm, "vm"],
    ] as const) {
      expect(
        customizeSpanExport({ id: "row", output: "original" }, [
          { onSpanExport: () => replacement },
        ]),
      ).toMatchObject({ id: "row", output });
    }

    // Cross-realm containers in the input are copied, not shared.
    const seen = vi.fn((data: SpanExportData) => data);
    const result = customizeSpanExport(
      { id: "row", metadata: crossRealm.metadata },
      [{ onSpanExport: seen }],
    );
    expect(seen.mock.calls[0][0].metadata).not.toBe(crossRealm.metadata);
    expect(result).toEqual({ id: "row", metadata: { nested: ["value"] } });
  });

  test("returns records untouched without customizers", () => {
    const metadata = { nested: { value: 1 } };
    const record = { id: "row", metadata };
    for (const customizers of [undefined, [], [{}]]) {
      const result = customizeSpanExport(record, customizers);
      expect(result).toBe(record);
      expect(result?.metadata).toBe(metadata);
    }
    expect(record).toEqual({ id: "row", metadata: { nested: { value: 1 } } });
  });

  test("hook mutations of nested payloads never reach the span cache", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attachment = new Attachment({
      data: new ArrayBuffer(1),
      filename: "file.txt",
      contentType: "text/plain",
    });
    const seenAttachments: unknown[] = [];
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            const metadata = data.metadata as Record<string, unknown>;
            const input = data.input as unknown[];
            if (!metadata || !input) return data;
            seenAttachments.push(input[1]);
            delete metadata.secret;
            input.push("injected");
            if (metadata.fail) throw new Error("fail after mutation");
            return data;
          },
        },
      ],
    });
    const experiment = _exportsForTestingOnly.initTestExperiment(
      "customizer-experiment",
      "customizer-project",
    );
    const state = _internalGetGlobalState();
    // Earlier span exports permanently disable the shared state's cache.
    const originalCache = state.spanCache;
    state.spanCache = new SpanCache();
    state.spanCache.start();
    try {
      const span = experiment.startSpan({ name: "cached" });
      span.log({
        input: ["prompt", attachment],
        metadata: { secret: "kept", fail: false },
      });
      const failing = span.startSpan({ name: "failing" });
      failing.log({
        input: ["prompt"],
        metadata: { secret: "kept", fail: true },
      });
      failing.end();
      span.end();

      const events = await memoryLogger.drain();
      const exported = events.find((event) => event.id === span.id);
      expect(exported).toHaveProperty("metadata", { fail: false });
      expect(exported).toHaveProperty("input", [
        "prompt",
        attachment,
        "injected",
      ]);
      // Attachments keep their identity rather than being copied.
      expect(seenAttachments[0]).toBe(attachment);

      const cached = state.spanCache.getByRootSpanId(span.rootSpanId);
      expect(
        cached?.find((entry) => entry.span_id === span.spanId),
      ).toMatchObject({
        input: ["prompt", expect.anything()],
        metadata: { secret: "kept", fail: false },
      });
      expect(
        cached?.find((entry) => entry.span_id === failing.spanId),
      ).toMatchObject({
        input: ["prompt"],
        metadata: { secret: "kept", fail: true },
      });
    } finally {
      state.spanCache.clearAll();
      state.spanCache = originalCache;
    }
  });

  test("throttles failure logs without exception or payload details", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const customizers = [
      {
        onSpanExport(): SpanExportData {
          throw new Error("private exception detail");
        },
      },
    ];
    const fail = () =>
      expect(
        customizeSpanExport({ id: "row", output: "private" }, customizers),
      ).toBeNull();

    fail();
    fail();
    fail();
    expect(errorLog).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(59_000);
    fail();
    expect(errorLog).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    fail();
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(errorLog.mock.calls[1][0]).toContain("3 additional records");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private");
  });

  test.each([false, true])(
    "rejected lazy record values behave the same with customizers (%s)",
    async (withCustomizers) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const onSpanExport = vi.fn((data: SpanExportData) => data);
      if (withCustomizers) {
        configureInstrumentation({ spanCustomizers: [{ onSpanExport }] });
      }
      const span = new SpanImpl({
        state: _internalGetGlobalState(),
        parentObjectType: SpanObjectTypeV3.PROJECT_LOGS,
        parentObjectId: new LazyValue<string>(async () => {
          throw new Error("object id lookup failed");
        }),
        parentComputeObjectMetadataArgs: undefined,
        parentSpanIds: undefined,
        name: "lazy failure",
      });
      span.end();

      await expect(memoryLogger.drain()).rejects.toThrow(
        "object id lookup failed",
      );
      expect(onSpanExport).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  test("drops async failures before attachments while exporting the rest of an HTTP batch", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failedAttachment = new Attachment({
      data: new ArrayBuffer(1),
      filename: "private.txt",
      contentType: "text/plain",
    });
    const attachmentUpload = vi.spyOn(failedAttachment, "upload");
    const successfulAttachment = new Attachment({
      data: new ArrayBuffer(1),
      filename: "safe.txt",
      contentType: "text/plain",
    });
    const successfulUpload = vi
      .spyOn(successfulAttachment, "upload")
      .mockResolvedValue({ upload_status: "done" });
    const laterHook = vi.fn((data: SpanExportData) => {
      const payload = Object.fromEntries(
        Object.entries(data).filter(([key]) =>
          ["input", "output", "metrics", "span_attributes"].includes(key),
        ),
      );
      return Object.freeze(payload);
    });
    configureInstrumentation({
      spanCustomizers: [
        {
          // @ts-expect-error Async customizers are unsupported, but must be contained.
          onSpanExport(data) {
            if (data.output === "private") {
              delete data.id;
              return Promise.reject(
                new Error("private async exception detail"),
              );
            }
            return data;
          },
        },
        { onSpanExport: laterHook },
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
    span.log({ input: failedAttachment, output: "private" });
    span.end();
    manual.log({ input: successfulAttachment, output: "manual output" });
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
      metrics: { start: expect.any(Number), end: expect.any(Number) },
    });
    expect(rows.find((row) => row.id === manual.id)).toMatchObject({
      input: successfulAttachment.reference,
      span_id: manual.spanId,
      root_span_id: manual.rootSpanId,
      project_id: "customizer-project",
      log_id: "g",
      output: "manual output",
      metrics: { start: expect.any(Number), end: expect.any(Number) },
    });
    expect(rows.find((row) => row.id === span.id)).not.toHaveProperty("output");
    expect(attachmentUpload).not.toHaveBeenCalled();
    expect(successfulUpload).toHaveBeenCalledTimes(1);
    expect(
      laterHook.mock.calls.some(([data]) => data.output === "private"),
    ).toBe(false);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private");
  });
});

describe("OpenTelemetry compat mode", () => {
  const customizer = { onSpanExport: (data: SpanExportData) => data };

  beforeEach(() => registry.disable());

  afterEach(() => {
    globalThis.BRAINTRUST_CONTEXT_MANAGER = undefined;
    vi.unstubAllEnvs();
    configureInstrumentation({ spanCustomizers: [] });
    vi.restoreAllMocks();
  });

  test.each([
    ["BRAINTRUST_OTEL_COMPAT", () => vi.stubEnv("BRAINTRUST_OTEL_COMPAT", "1")],
    [
      "setupOtelCompat() globals",
      () => {
        globalThis.BRAINTRUST_CONTEXT_MANAGER = class {} as never;
      },
    ],
  ])("rejects registering customizers under %s", (_name, enableCompat) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    enableCompat();
    configureInstrumentation({ spanCustomizers: [customizer] });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const record = { id: "row", output: "original" };
    expect(customizeSpanExport(record)).toBe(record);
    expect(customizeSpanExport({ ...record, id: "row-2" })).toEqual({
      ...record,
      id: "row-2",
    });
    expect(errorLog).toHaveBeenCalledTimes(1);

    configureInstrumentation({ spanCustomizers: [customizer] });
    expect(errorLog).toHaveBeenCalledTimes(2);

    configureInstrumentation({ spanCustomizers: [] });
    configureInstrumentation({ spanCustomizers: undefined });
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  test("keeps the previous registration after rejecting a replacement", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport: (data) => ({ ...data, output: "previous customizer" }),
        },
      ],
    });
    vi.stubEnv("BRAINTRUST_OTEL_COMPAT", "1");

    configureInstrumentation({ spanCustomizers: [customizer] });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(customizeSpanExport({ output: "original" })).toEqual({
      output: "previous customizer",
    });

    configureInstrumentation({ spanCustomizers: undefined });
    const record = { output: "original" };
    expect(customizeSpanExport(record)).toBe(record);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
