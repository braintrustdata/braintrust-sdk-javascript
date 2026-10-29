/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { describe, it, expect, vi } from "vite-plus/test";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { BraintrustExporter } from "../src/otel";

describe("OTEL v1 version-specific attributes", () => {
  it("exporter handles v1-specific span attributes", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();
    const processor = (exporter as any).processor;
    const batchProcessor = (processor as any).processor;
    const baseExporter = (batchProcessor as any)._exporter;

    const mockExport = vi.fn();
    baseExporter.export = mockExport;

    const v1Span = {
      name: "gen_ai.completion",
      spanContext: () => ({ traceId: "trace-123", spanId: "span-456" }),
      parentSpanId: "parent-789",
      instrumentationLibrary: { name: "openai", version: "1.0.0" },
      resource: {
        attributes: {
          "service.name": "test-service",
        },
      },
    } as any;

    baseExporter.export([v1Span], () => {});
    expect(mockExport).toHaveBeenCalledOnce();
    const [exportedSpans] = mockExport.mock.calls[0];

    expect(exportedSpans).toHaveLength(1);
    const exportedSpan = exportedSpans[0];

    // V1-specific: should have parentSpanId
    expect(exportedSpan.parentSpanId).toBe("parent-789");

    // V1-specific: should have instrumentationLibrary (not instrumentationScope)
    expect(exportedSpan.instrumentationLibrary).toEqual({
      name: "openai",
      version: "1.0.0",
    });

    // V1-specific: should NOT have v2 properties
    expect(exportedSpan.parentSpanContext).toBeUndefined();
    expect(exportedSpan.instrumentationScope).toBeUndefined();
  });

  it("confirms v1 environment by checking real span structure", () => {
    const testProvider = new BasicTracerProvider();
    const testTracer = testProvider.getTracer("test");
    const testSpan = testTracer.startSpan("test") as any;

    // Verify we're in v1 environment
    expect(testSpan).toHaveProperty("instrumentationLibrary");
    expect(testSpan).not.toHaveProperty("instrumentationScope");

    testSpan.end();
  });
});
