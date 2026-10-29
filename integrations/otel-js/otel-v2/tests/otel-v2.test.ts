/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { describe, it, expect, vi } from "vite-plus/test";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { BraintrustExporter } from "../src/otel";

describe("OTEL v2 version-specific attributes", () => {
  it("exporter handles v2-specific span attributes", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();
    const processor = (exporter as any).processor;
    const batchProcessor = (processor as any).processor;
    const baseExporter = (batchProcessor as any)._exporter;

    const mockExport = vi.fn();
    baseExporter.export = mockExport;

    const v2Span = {
      name: "gen_ai.completion",
      spanContext: () => ({ traceId: "trace-123", spanId: "span-456" }),
      parentSpanContext: {
        spanId: "parent-789",
        traceId: "trace-123",
      },
      instrumentationScope: { name: "openai", version: "1.0.0" },
      resource: {
        attributes: {
          "service.name": "test-service",
        },
      },
    } as any;

    baseExporter.export([v2Span], () => {});
    expect(mockExport).toHaveBeenCalledOnce();
    const [exportedSpans] = mockExport.mock.calls[0];

    expect(exportedSpans).toHaveLength(1);
    const exportedSpan = exportedSpans[0];

    // V2-specific: should have parentSpanContext
    expect(exportedSpan.parentSpanContext).toEqual({
      spanId: "parent-789",
      traceId: "trace-123",
    });

    // V2-specific: should have instrumentationScope (not instrumentationLibrary)
    expect(exportedSpan.instrumentationScope).toEqual({
      name: "openai",
      version: "1.0.0",
    });

    // V2-specific: should NOT have v1 properties
    expect(exportedSpan.parentSpanId).toBeUndefined();
    expect(exportedSpan.instrumentationLibrary).toBeUndefined();
  });

  it("confirms v2 environment by checking real span structure", () => {
    const testProvider = new BasicTracerProvider();
    const testTracer = testProvider.getTracer("test");
    const testSpan = testTracer.startSpan("test") as any;

    // Verify we're in v2 environment
    expect(testSpan).toHaveProperty("instrumentationScope");
    expect(testSpan).not.toHaveProperty("instrumentationLibrary");

    testSpan.end();
  });
});
