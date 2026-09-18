import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";
import {
  _exportsForTestingOnly,
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
});
