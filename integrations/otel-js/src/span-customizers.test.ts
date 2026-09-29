import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { setupOtelCompat, resetOtelCompat, BraintrustSpanProcessor } from ".";
import { createTracerProvider } from "../tests/utils";

// Braintrust stores configured span customizers under this shared symbol.
const SPAN_CUSTOMIZERS_KEY = Symbol.for("braintrust.spanCustomizers");
const shared = globalThis as Record<string | symbol, unknown>;

describe("setupOtelCompat with span customizers", () => {
  afterEach(() => {
    delete shared[SPAN_CUSTOMIZERS_KEY];
    resetOtelCompat();
    vi.restoreAllMocks();
  });

  test("logs once per setup attempt and continues exporting spans", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSpanExport = vi.fn((data: unknown) => data);
    const customizers = [{ onSpanExport }];
    shared[SPAN_CUSTOMIZERS_KEY] = customizers;

    setupOtelCompat();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(shared.BRAINTRUST_CONTEXT_MANAGER).toBeDefined();
    expect(shared.BRAINTRUST_ID_GENERATOR).toBeDefined();
    expect(shared.BRAINTRUST_SPAN_COMPONENT).toBeDefined();
    expect(shared[SPAN_CUSTOMIZERS_KEY]).toBe(customizers);

    const exporter = new InMemorySpanExporter();
    const provider = createTracerProvider(BasicTracerProvider, [
      new BraintrustSpanProcessor({
        parent: "project_name:customizer-compat",
        _spanProcessor: new SimpleSpanProcessor(exporter),
      }),
    ]);
    try {
      const tracer = provider.getTracer("customizer-compat");
      tracer.startSpan("first").end();
      tracer.startSpan("second").end();
      await provider.forceFlush();
      expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "first",
        "second",
      ]);
      expect(onSpanExport).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);

      setupOtelCompat();
      expect(errorLog).toHaveBeenCalledTimes(2);
      expect(shared[SPAN_CUSTOMIZERS_KEY]).toBe(customizers);
    } finally {
      await provider.shutdown();
    }
  });

  test.each([undefined, []])(
    "allows setup when customizers are cleared (%j)",
    (customizers) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      shared[SPAN_CUSTOMIZERS_KEY] = customizers;
      setupOtelCompat();
      expect(shared.BRAINTRUST_CONTEXT_MANAGER).toBeDefined();
      expect(shared.BRAINTRUST_ID_GENERATOR).toBeDefined();
      expect(shared.BRAINTRUST_SPAN_COMPONENT).toBeDefined();
      expect(errorLog).not.toHaveBeenCalled();
    },
  );
});
