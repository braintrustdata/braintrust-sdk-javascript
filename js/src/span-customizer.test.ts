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
  mergeCustomizedSpanRecords,
  resetSpanCustomizerFailureLoggingForTests,
} from "./span-customizer";
import { processInputAttachments } from "./wrappers/attachment-utils";
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
    vi.stubEnv("BRAINTRUST_DEBUG_LOG_LEVEL", "error");
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
      const strippedRecords = enqueue.mock.calls.flatMap(([items]) => items);

      // A failure stays separate from preceding and subsequent safe updates.
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
        {
          id: span.id,
          ...(entrypoint === "experiment"
            ? { experiment_id: "customizer-experiment" }
            : {
                project_id: "customizer-project",
                log_id: "g",
                span_id: span.spanId,
                root_span_id: span.rootSpanId,
              }),
          _is_merge: true,
          context: { customizer_error: true },
        },
      ]);
      expect(onSpanExport).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private");

      for (const record of strippedRecords) {
        expect(await record.get()).toEqual(events[1]);
        expect(await record.get()).toEqual(events[1]);
      }
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
    ["custom null-root prototype", () => Object.create(Object.create(null))],
    ["resolved promise", () => Promise.resolve({ output: "private" })],
    ["rejected promise", () => Promise.reject(new Error("private rejection"))],
  ])(
    "strips the failing record on %s and stops its callback chain",
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
      expect(events).toHaveLength(3);
      expect(events[1]).toEqual({
        id: span.id,
        span_id: span.spanId,
        root_span_id: span.rootSpanId,
        project_id: "customizer-project",
        log_id: "g",
        _is_merge: true,
        context: { customizer_error: true },
      });
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

      // Stripping one incremental record does not disable its logical span.
      span.log({ output: "recovered" });
      span.end();
      expect(await memoryLogger.drain()).toEqual([
        expect.objectContaining({ id: span.id, output: "recovered" }),
      ]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    },
  );

  test.each([{}, { start: 10 }, { end: 20 }, { start: 10, end: 20 }])(
    "retains only original protocol fields and duration %j after earlier mutations",
    (duration) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const laterHook = vi.fn((data: SpanExportData) => data);
      const original = {
        id: "row",
        span_id: "span",
        root_span_id: "root",
        span_parents: ["parent"],
        org_id: "org",
        project_id: "project",
        log_id: "g",
        _is_merge: true,
        _merge_paths: [["metadata"]],
        _parent_id: "parent-row",
        _xact_id: "transaction",
        _object_delete: false,
        _array_delete: [],
        created: "private",
        name: "private",
        span_attributes: { name: "private" },
        input: "private",
        output: "private",
        expected: "private",
        metadata: { secret: "private" },
        context: { secret: "private" },
        attributes: { secret: "private" },
        events: ["private"],
        links: ["private"],
        error: "private",
        tags: ["private"],
        scores: { secret: 1 },
        attachments: ["private"],
        unknown: "private",
        metrics: { ...duration, tokens: 99, custom: 42 },
      };
      const result = customizeSpanExport(original, [
        {
          onSpanExport(data) {
            data.id = "wrong";
            (data.span_parents as string[]).push("wrong");
            (data._merge_paths as string[][])[0].push("wrong");
            data.metrics = { start: 999, end: 999, tokens: 999 };
            data.context = { secret: "earlier hook" };
            data.output = "earlier hook";
            return data;
          },
        },
        {
          onSpanExport(data) {
            delete data.root_span_id;
            (data.metrics as SpanExportData).end = 1234;
            throw new Error("private failure");
          },
        },
        { onSpanExport: laterHook },
      ]);
      expect(result).toEqual({
        id: "row",
        span_id: "span",
        root_span_id: "root",
        span_parents: ["parent"],
        org_id: "org",
        project_id: "project",
        log_id: "g",
        _is_merge: true,
        _merge_paths: [["metadata"]],
        _parent_id: "parent-row",
        _xact_id: "transaction",
        _object_delete: false,
        _array_delete: [],
        ...(Object.keys(duration).length ? { metrics: duration } : {}),
        context: { customizer_error: true },
      });
      expect(original.metrics).toEqual({ ...duration, tokens: 99, custom: 42 });
      expect(laterHook).not.toHaveBeenCalled();
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

  test("memoizes stripped records across repeated evaluations", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSpanExport = vi.fn(() => {
      throw new Error("private failure");
    });
    const laterHook = vi.fn((data: SpanExportData) => data);
    configureInstrumentation({
      spanCustomizers: [{ onSpanExport }, { onSpanExport: laterHook }],
    });
    const enqueue = vi.spyOn(memoryLogger, "log");
    const span = startInstrumentedSpan();
    const records = enqueue.mock.calls.flatMap(([items]) => items);
    const events = await memoryLogger.drain();
    expect(events).toEqual([
      {
        id: span.id,
        span_id: span.spanId,
        root_span_id: span.rootSpanId,
        project_id: "customizer-project",
        log_id: "g",
        _is_merge: false,
        metrics: { start: expect.any(Number) },
        context: { customizer_error: true },
      },
    ]);
    for (const record of records) {
      expect(await record.get()).toBe(events[0]);
      expect(await record.get()).toBe(events[0]);
    }
    expect(onSpanExport).toHaveBeenCalledTimes(1);
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

  test("logs the failure once logging is enabled after a silenced failure", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = _internalGetGlobalState();
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(): SpanExportData {
            throw new Error("private exception detail");
          },
        },
      ],
    });

    state.setDebugLogLevel(false);
    customizeSpanExport({ id: "silenced" });
    expect(errorLog).not.toHaveBeenCalled();

    state.setDebugLogLevel("error");
    customizeSpanExport({ id: "visible" });
    customizeSpanExport({ id: "deduplicated" });
    expect(errorLog.mock.calls).toEqual([
      [
        "[braintrust]",
        "Span export customizer failed; exporting only span identity and duration.",
      ],
    ]);
  });

  test("logs safely once across time, registrations, and SDK module copies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const customizers = [
      {
        onSpanExport(): SpanExportData {
          throw new Error("private exception detail");
        },
      },
    ];
    for (let i = 0; i < 3; i++) {
      configureInstrumentation({ spanCustomizers: customizers });
      expect(customizeSpanExport({ id: "row", output: "private" })).toEqual({
        id: "row",
        context: { customizer_error: true },
      });
      vi.advanceTimersByTime(86_400_000);
    }
    // Reload intentionally models separately bundled SDK module state.
    vi.resetModules();
    const otherBundle = await import("./span-customizer");
    expect(
      otherBundle.customizeSpanExport({ id: "other", input: "private" }),
    ).toEqual({
      id: "other",
      context: { customizer_error: true },
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls).toEqual([
      [
        "[braintrust]",
        "Span export customizer failed; exporting only span identity and duration.",
      ],
    ]);
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

  test("strips async failures before attachments and sends ordered HTTP batches through retries", async () => {
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
    let hookCalls = 0;
    configureInstrumentation({
      spanCustomizers: [
        {
          // @ts-expect-error Async customizers are unsupported, but must be contained.
          onSpanExport(data) {
            hookCalls++;
            if (data.output === "private") {
              delete data.id;
              data.metrics = { start: 999, end: 999, tokens: 999 };
              data.context = { secret: "private mutated context" };
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
    const requests: Record<string, unknown>[][] = [];
    let retried = false;
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
          const batch = JSON.parse(String(options?.body)).rows;
          requests.push(batch);
          if (
            !retried &&
            batch.some(
              (row: SpanExportData) =>
                (row.context as SpanExportData)?.customizer_error,
            )
          ) {
            retried = true;
            return Response.json({}, { status: 503 });
          }
          rows.push(...batch);
          return Response.json({});
        }
        throw new Error(`Unexpected test request: ${pathname}`);
      },
    });
    const mask = vi.fn((value: unknown) => {
      if (value && typeof value === "object" && "customizer_error" in value) {
        return { injected: "must not replace diagnostics" };
      }
      if (value && typeof value === "object" && "start" in value) {
        return { start: 999 };
      }
      return value;
    });
    state.setMaskingFunction(mask);
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
    span.log({
      input: failedAttachment,
      output: "private",
      metrics: { start: 10, tokens: 99 },
    });
    span.end();
    manual.log({ input: successfulAttachment, output: "manual output" });
    manual.end();
    await logger.flush();

    expect(rows).toHaveLength(5);
    const stripped = rows.find(
      (row) => (row.context as SpanExportData)?.customizer_error,
    );
    expect(stripped).toEqual({
      id: span.id,
      span_id: span.spanId,
      root_span_id: manual.rootSpanId,
      span_parents: [manual.spanId],
      project_id: "customizer-project",
      log_id: "g",
      _is_merge: true,
      context: { customizer_error: true },
      metrics: { start: 10 },
    });
    const failedRequests = requests.filter((batch) =>
      batch.some((row) => (row.context as SpanExportData)?.customizer_error),
    );
    expect(failedRequests).toEqual([[stripped], [stripped]]);
    expect(
      requests.map((batch) =>
        batch.map(
          (row) => (row.context as SpanExportData)?.customizer_error === true,
        ),
      ),
    ).toEqual([[false, false], [true], [true], [false, false]]);
    expect(
      requests.every(
        (batch) => new Set(batch.map((row) => row.id)).size === batch.length,
      ),
    ).toBe(true);
    expect(rows.find((row) => row.output === "manual output")).toMatchObject({
      input: successfulAttachment.reference,
      span_id: manual.spanId,
      root_span_id: manual.rootSpanId,
      project_id: "customizer-project",
      log_id: "g",
      output: "manual output",
      metrics: { end: expect.any(Number) },
    });
    expect(rows.find((row) => row.id === span.id)).not.toHaveProperty("output");
    expect(attachmentUpload).not.toHaveBeenCalled();
    expect(successfulUpload).toHaveBeenCalledTimes(1);
    expect(
      laterHook.mock.calls.some(([data]) => data.output === "private"),
    ).toBe(false);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private");
    expect(hookCalls).toBe(6);
    expect(laterHook).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(mask.mock.calls)).not.toContain("customizer_error");
  });

  test("only splits merge groups where a stripped record shares an ID", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = [
      {
        onSpanExport(): SpanExportData {
          throw new Error("private failure");
        },
      },
    ];
    const strip = (id: string) =>
      customizeSpanExport(
        { id, _is_merge: true, output: "private" },
        failing,
      ) as {
        id: string;
      };
    const a = strip("a");
    const b = strip("b");
    const a2 = strip("a");
    const y = { id: "y", _is_merge: true, output: 3 };

    const groups = mergeCustomizedSpanRecords([
      { id: "x", input: 1 },
      a,
      b,
      { id: "x", _is_merge: true, output: 2 },
      a2,
      y,
    ]);

    expect(groups).toEqual([
      [{ id: "x", input: 1, output: 2 }, a, b],
      [a2, y],
    ]);
    expect(groups[0][1]).toBe(a);
    expect(groups[1][0]).toBe(a2);
  });

  function initHttpLogger(onLogs: (rows: SpanExportData[]) => Response) {
    // Keep all records in one flush chunk.
    vi.stubEnv("BRAINTRUST_SYNC_FLUSH", "1");
    vi.stubEnv("BRAINTRUST_NUM_RETRIES", "0");
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
          return onLogs(JSON.parse(String(options?.body)).rows);
        }
        throw new Error(`Unexpected test request: ${pathname}`);
      },
    });
    return { state, logger };
  }

  test("stops sending later ordered groups after a group fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            if (data.output === "private") throw new Error("private failure");
            return data;
          },
        },
      ],
    });
    const requests: SpanExportData[][] = [];
    const { logger } = initHttpLogger((rows) => {
      requests.push(rows);
      return rows.some(
        (row) => (row.context as SpanExportData)?.customizer_error,
      )
        ? Response.json({}, { status: 500 })
        : Response.json({});
    });
    const span = logger.startSpan({ name: "manual" });
    span.log({ output: "private" });
    span.end();
    await logger.flush();

    expect(
      requests.map((rows) =>
        rows.map((row) => (row.context as SpanExportData)?.customizer_error),
      ),
    ).toEqual([[undefined], [true]]);
  });

  test("decision customizer removal uploads only surviving media", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
    const upload = vi
      .spyOn(Attachment.prototype, "upload")
      .mockResolvedValue({ upload_status: "done" });
    const rows: SpanExportData[] = [];
    const { logger } = initHttpLogger((batch) => {
      rows.push(...batch);
      return Response.json({});
    });
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            if (
              data.input &&
              typeof data.input === "object" &&
              "state" in data.input &&
              Array.isArray(data.input.state)
            ) {
              data.input.state.splice(0, 1);
            }
            return data;
          },
        },
      ],
    });
    const input = {
      state: [
        {
          type: "file",
          mediaType: "text/plain",
          filename: "private.txt",
          data: "cHJpdmF0ZQ==",
        },
        {
          type: "file",
          mediaType: "text/plain",
          filename: "kept.txt",
          data: "a2VwdA==",
        },
      ],
      questions: [],
    };
    const span = logger.startSpan({
      name: "evaluate",
      spanAttributes: { type: "question" },
      event: { input },
    });
    span.end();
    await logger.flush();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.instances[0]).toMatchObject({
      reference: { filename: "kept.txt" },
    });
    expect(rows.find((row) => row.id === span.id)).toMatchObject({
      input: {
        state: [
          {
            ...input.state[1],
            data: { type: "braintrust_attachment", filename: "kept.txt" },
          },
        ],
        questions: [],
      },
    });
    expect(input.state).toHaveLength(2);
  });

  test.each(["customizer", "masking", "upload failure"])(
    "decision media survives export with %s and never uploads redacted media",
    async (mode) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
      const media =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
      const upload = vi
        .spyOn(Attachment.prototype, "upload")
        .mockRejectedValue(new Error("injected upload failure"));
      const rows: SpanExportData[] = [];
      const { state, logger } = initHttpLogger((batch) => {
        rows.push(...batch);
        return Response.json({});
      });
      const redact = (value: unknown) =>
        JSON.parse(JSON.stringify(value).replaceAll(media, "[redacted]"));
      if (mode === "customizer") {
        configureInstrumentation({
          spanCustomizers: [
            {
              onSpanExport(data) {
                if (data.input) data.input = redact(data.input);
                return data;
              },
            },
          ],
        });
      } else if (mode === "masking") {
        state.setMaskingFunction(redact);
      }
      const input = {
        state: [{ type: "file", data: media, mediaType: "image/png" }],
        questions: [{ id: "q", type: "boolean", instructions: "Inspect" }],
      };
      const span = logger.startSpan({
        name: "evaluate",
        spanAttributes: { type: "question" },
      });
      span.log({
        input,
        output: { answers: [{ id: "q", type: "boolean", probability: 0.9 }] },
      });
      span.end();
      await logger.flush();
      expect(rows.find((row) => row.id === span.id)).toMatchObject({
        input: mode === "upload failure" ? input : redact(input),
        output: { answers: [{ id: "q", type: "boolean", probability: 0.9 }] },
      });
      expect(upload).toHaveBeenCalledTimes(mode === "upload failure" ? 1 : 0);
      expect(input.state[0].data).toBe(media);
    },
  );

  test.each(["done", "error", "throw"])(
    "automatic decision attachments export safely on %s",
    async (result) => {
      const image =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
      const input = {
        state: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "inspect" },
              { type: "input_image", image_url: image },
              { type: "input_image", image_url: image },
              { type: "input_image", image_url: image },
            ],
          },
        ],
        questions: [
          { id: "visible", type: "boolean", instructions: "Visible?" },
        ],
      };
      const processed = processInputAttachments(input, true);
      const uploads = processed.state[0].content
        .slice(1)
        .map((part: { image_url: Attachment }, index: number) =>
          vi.spyOn(part.image_url, "upload").mockImplementation(async () => {
            if (index === 2 && result === "throw")
              throw new Error("upload failed");
            return {
              upload_status:
                index === 2 && result === "error" ? "error" : "done",
            };
          }),
        );
      configureInstrumentation({
        spanCustomizers: [
          {
            onSpanExport(data) {
              if (data.input) {
                const value = data.input as typeof input;
                value.state[0].content[1].image_url = "[redacted]";
              }
              return data;
            },
          },
        ],
      });
      const rows: SpanExportData[] = [];
      const { logger } = initHttpLogger((batch) => {
        rows.push(...batch);
        return Response.json({});
      });
      const span = logger.startSpan({
        name: "openai.decisions.create",
        spanAttributes: { type: "question" },
      });
      span.log({
        input: processed,
        output: {
          answers: [{ id: "visible", type: "boolean", probability: 1 }],
        },
      });
      span.end();
      await logger.flush();
      const exported = rows.find((row) => row.id === span.id)!;
      const expected = structuredClone(input);
      expected.state[0].content[1].image_url = "[redacted]";
      if (result === "done") {
        expect(exported.input).toMatchObject({
          state: [
            {
              content: [
                { type: "input_text", text: "inspect" },
                { type: "input_image", image_url: "[redacted]" },
                {
                  type: "input_image",
                  image_url: {
                    type: "braintrust_attachment",
                    content_type: "image/png",
                  },
                },
                {
                  type: "input_image",
                  image_url: {
                    type: "braintrust_attachment",
                    content_type: "image/png",
                  },
                },
              ],
            },
          ],
        });
      } else {
        expect(exported.input).toEqual(expected);
        // A failed pipeline skips uploads for subsequent spans and keeps inline data.
        const later = processInputAttachments(input, true);
        const laterUpload = vi.spyOn(
          later.state[0].content[2].image_url,
          "upload",
        );
        const next = logger.startSpan({ name: "next" });
        next.log({ input: later });
        next.end();
        await logger.flush();
        expect(laterUpload).not.toHaveBeenCalled();
        expect(rows.find((row) => row.id === next.id)?.input).toEqual(expected);
      }
      expect(uploads[0]).not.toHaveBeenCalled();
      expect(uploads[1]).toHaveBeenCalledOnce();
      expect(uploads[2]).toHaveBeenCalledOnce();
      expect(exported.output).toEqual({
        answers: [{ id: "visible", type: "boolean", probability: 1 }],
      });
      expect(input.state[0].content[1].image_url).toBe(image);
    },
  );

  test("does not upload attachments whose references were masked away", async () => {
    const masked = new Attachment({
      data: new ArrayBuffer(1),
      filename: "private.txt",
      contentType: "text/plain",
    });
    const maskedUpload = vi.spyOn(masked, "upload");
    const kept = new Attachment({
      data: new ArrayBuffer(1),
      filename: "safe.txt",
      contentType: "text/plain",
    });
    const keptUpload = vi
      .spyOn(kept, "upload")
      .mockResolvedValue({ upload_status: "done" });
    const rows: SpanExportData[] = [];
    const { state, logger } = initHttpLogger((batch) => {
      rows.push(...batch);
      return Response.json({});
    });
    state.setMaskingFunction((value) => {
      if (JSON.stringify(value)?.includes("private.txt")) {
        throw new Error("private failure");
      }
      return value;
    });
    const span = logger.startSpan({ name: "manual" });
    span.log({ input: masked, output: kept });
    span.end();
    await logger.flush();

    expect(rows.find((row) => row.id === span.id)).toMatchObject({
      input: "ERROR: Failed to mask field 'input' - Error",
      output: kept.reference,
    });
    expect(maskedUpload).not.toHaveBeenCalled();
    expect(keptUpload).toHaveBeenCalledTimes(1);
  });
});

describe("OpenTelemetry compat mode", () => {
  const customizer = {
    onSpanExport: (data: SpanExportData) => ({ ...data, output: "redacted" }),
  };

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
  ])("registers and clears customizers under %s", (_name, enableCompat) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    enableCompat();
    configureInstrumentation({ spanCustomizers: [customizer] });
    expect(customizeSpanExport({ id: "row", output: "private" })).toEqual({
      id: "row",
      output: "redacted",
    });
    configureInstrumentation({
      spanCustomizers: [
        { onSpanExport: (data) => ({ ...data, output: "replacement" }) },
      ],
    });
    expect(customizeSpanExport({ output: "private" })).toEqual({
      output: "replacement",
    });
    configureInstrumentation({ spanCustomizers: [] });
    const record = { output: "original" };
    expect(customizeSpanExport(record)).toBe(record);
    configureInstrumentation({ spanCustomizers: undefined });
    expect(errorLog).not.toHaveBeenCalled();
  });
});
