import { expect, test } from "vite-plus/test";
import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { BraintrustExporter, BraintrustSpanProcessor } from "@braintrust/otel";

test("OTel 2 accepts the adapters and exports real parent and child spans", async () => {
  const memory = new InMemorySpanExporter();
  const exporter = new BraintrustExporter({
    exporter: memory,
  }) satisfies SpanExporter;
  const processor = new BraintrustSpanProcessor({
    processor: new BatchSpanProcessor(exporter),
  }) satisfies SpanProcessor;
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  try {
    const tracer = provider.getTracer("compatibility-test", "1.0.0");
    const root = tracer.startSpan("root");
    const child = tracer.startSpan(
      "child",
      {},
      trace.setSpan(context.active(), root),
    );
    child.end();
    root.end();
    await provider.forceFlush();
    const spans = memory.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(["child", "root"]);
    expect(spans[0].spanContext().traceId).toBe(root.spanContext().traceId);
    expect(spans[0].parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(spans[0].instrumentationScope.name).toBe("compatibility-test");
    expect(
      JSON.parse(spans[0].attributes["braintrust.context_json"] as string),
    ).toHaveProperty("span_origin.instrumentation.name", "braintrust-otel-js");
  } finally {
    await provider.shutdown();
  }
});
