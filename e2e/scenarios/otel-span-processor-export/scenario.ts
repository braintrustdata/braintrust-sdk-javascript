import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { context, trace } from "@opentelemetry/api";
import {
  BraintrustSpanProcessor,
  BraintrustExporter,
  braintrustOtlpConfig,
} from "@braintrust/otel";
import {
  createTracerProvider,
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const processor = new BraintrustSpanProcessor({
    processor: new BatchSpanProcessor(
      new BraintrustExporter({
        exporter: new OTLPTraceExporter(
          braintrustOtlpConfig({
            apiKey: process.env.BRAINTRUST_API_KEY!,
            apiUrl: process.env.BRAINTRUST_API_URL!,
            parent: `project_name:${scopedName("e2e-otel-span-processor-export", testRunId)}`,
          }),
        ),
      }),
    ),
    filterAISpans: true,
  });
  const provider = createTracerProvider([processor]);
  trace.setGlobalTracerProvider(provider);

  const tracer = trace.getTracer("e2e-otel-export");
  const rootSpan = tracer.startSpan("root-operation");
  const rootContext = trace.setSpan(context.active(), rootSpan);
  const aiSpan = tracer.startSpan("gen_ai.completion", undefined, rootContext);
  aiSpan.setAttribute("gen_ai.system", "openai");
  aiSpan.end();
  rootSpan.end();

  await processor.forceFlush();
  await (provider as { shutdown?: () => Promise<void> }).shutdown?.();
}

runMain(main);
