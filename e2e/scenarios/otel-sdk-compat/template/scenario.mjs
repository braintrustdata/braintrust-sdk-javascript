import assert from "node:assert/strict";
import { configureInstrumentation } from "braintrust/instrumentation";

let customized = 0;
configureInstrumentation({
  spanCustomizers: [
    {
      onSpanExport(data) {
        if ("attributes" in data) {
          customized++;
          delete data.attributes.secret;
          data.attributes.reviewed = true;
        }
        return data;
      },
    },
  ],
});

const { context, trace, createTraceState } = await import("@opentelemetry/api");
const { AsyncLocalStorageContextManager } =
  await import("@opentelemetry/context-async-hooks");
const { OTLPTraceExporter } =
  await import("@opentelemetry/exporter-trace-otlp-http");
const {
  BraintrustExporter,
  BraintrustSpanProcessor,
  braintrustOtlpConfig,
  setupOtelCompat,
  resetOtelCompat,
  contextFromSpan,
} = await import("@braintrust/otel");
const { initLogger, withCurrent, currentSpan } = await import("braintrust");
const modern = process.env.OTEL_MAJOR === "3";
const sdk = await import(
  modern ? "@opentelemetry/sdk-trace" : "@opentelemetry/sdk-trace-base"
);
const testRunId = process.env.BRAINTRUST_E2E_RUN_ID;
const projectName =
  process.env.BRAINTRUST_E2E_PROJECT_NAME || `tmp-luca-otel-${testRunId}`;
const exporter = new BraintrustExporter({
  exporter: new OTLPTraceExporter(
    braintrustOtlpConfig({ parent: `project_name:${projectName}` }),
  ),
});
const batch = modern
  ? new sdk.BatchSpanProcessor({ exporter })
  : new sdk.BatchSpanProcessor(exporter);
const processor = new BraintrustSpanProcessor({
  processor: batch,
  filterAISpans: true,
});
const Provider = modern ? sdk.TracerProvider : sdk.BasicTracerProvider;
const provider = new Provider(
  process.env.OTEL_MAJOR === "1" ? {} : { spanProcessors: [processor] },
);
// The pinned OTel 1 line is configured through addSpanProcessor.
if (process.env.OTEL_MAJOR === "1") provider.addSpanProcessor(processor);
const contextManager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(contextManager);
trace.setGlobalTracerProvider(provider);
setupOtelCompat();
try {
  const logger = initLogger({ projectName });
  const root = logger.startSpan({
    name: "native-root",
    event: { metadata: { testRunId, scenario: "otel-sdk-compat" } },
  });
  const tracer = trace.getTracer("otel-sdk-compat", "1.0.0");
  await withCurrent(root, async () => {
    await Promise.resolve();
    assert.equal(currentSpan(), root);
    await tracer.startActiveSpan("gen_ai.child", async (span) => {
      assert.equal(span.spanContext().traceId, root.rootSpanId);
      span.setAttributes({
        testRunId,
        scenario: "otel-sdk-compat",
        secret: "private-payload",
      });
      const child = logger.startSpan({
        name: "native-grandchild",
        event: { metadata: { testRunId, scenario: "otel-sdk-compat" } },
      });
      assert.deepEqual(child.spanParents, [span.spanContext().spanId]);
      child.end();
      await Promise.resolve();
      span.end();
    });
    tracer.startSpan("filtered-out").end();
  });
  const unsampled = trace.setSpanContext(context.active(), {
    traceId: root.rootSpanId,
    spanId: root.spanId,
    traceFlags: 0,
    traceState: createTraceState("vendor=value"),
    isRemote: true,
  });
  await context.with(unsampled, () =>
    logger.traced(
      async (native) => {
        assert.match(native.inject().traceparent, /-00$/);
        assert.equal(native.inject().tracestate, "vendor=value");
        const child = tracer.startSpan("gen_ai.unsampled");
        assert.equal(child.isRecording(), false);
        assert.equal(child.spanContext().traceFlags, 0);
        child.end();
        const propagated = trace.getSpanContext(contextFromSpan(native));
        assert.equal(propagated.traceFlags, 0);
        assert.equal(propagated.traceState.serialize(), "vendor=value");
      },
      {
        name: "native-under-unsampled-parent",
        event: { metadata: { testRunId, scenario: "otel-sdk-compat" } },
      },
    ),
  );
  const remote = tracer.startSpan("gen_ai.remote", {}, contextFromSpan(root));
  remote.setAttributes({
    testRunId,
    scenario: "otel-sdk-compat",
    secret: "private-payload",
  });
  remote.end();
  root.end();
  await logger.flush();
  await provider.forceFlush();
  assert.equal(customized, 2);
  console.log(
    JSON.stringify({ rootSpanId: root.rootSpanId, rootId: root.spanId }),
  );
} finally {
  await provider.shutdown();
  resetOtelCompat();
  context.disable();
  trace.disable();
  contextManager.disable();
}
