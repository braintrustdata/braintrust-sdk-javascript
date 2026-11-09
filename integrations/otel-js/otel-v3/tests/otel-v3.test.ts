import { expect, test } from "vite-plus/test";
import { context, trace } from "@opentelemetry/api";
import {
  TracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { BraintrustExporter, BraintrustSpanProcessor } from "@braintrust/otel";

test("OTel 3 accepts the adapters and exports real parent and child spans", async () => {
  const memory = new InMemorySpanExporter();
  const exporter = new BraintrustExporter({
    exporter: memory,
  }) satisfies SpanExporter;
  const batch = new BatchSpanProcessor({ exporter });
  const downstream: SpanProcessor = {
    onStart: (span, parent) => batch.onStart(span, parent),
    onEnding: (span) => span.setAttribute("ending-hook", true),
    onEnd: (span) => batch.onEnd(span),
    forceFlush: () => batch.forceFlush(),
    shutdown: () => batch.shutdown(),
  };
  const processor = new BraintrustSpanProcessor({
    processor: downstream,
  }) satisfies SpanProcessor;
  const provider = new TracerProvider({ spanProcessors: [processor] });
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
    expect(spans.every((span) => span.attributes["ending-hook"] === true)).toBe(
      true,
    );
    expect(spans[0].instrumentationScope.name).toBe("compatibility-test");
    expect(
      JSON.parse(spans[0].attributes["braintrust.context_json"] as string),
    ).toHaveProperty("span_origin.instrumentation.name", "braintrust-otel-js");
  } finally {
    await provider.shutdown();
  }
});
