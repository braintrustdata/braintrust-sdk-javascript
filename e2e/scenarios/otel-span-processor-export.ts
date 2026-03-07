import { context, trace } from "@opentelemetry/api";
import { BraintrustSpanProcessor } from "@braintrust/otel";
import {
  createTracerProvider,
  getTestRunId,
  runMain,
  scopedName,
} from "./helpers";

async function main() {
  const testRunId = getTestRunId();
  const processor = new BraintrustSpanProcessor({
    apiKey: process.env.BRAINTRUST_API_KEY!,
    apiUrl: process.env.BRAINTRUST_API_URL!,
    filterAISpans: true,
    parent: `project_name:${scopedName("e2e-otel-span-processor-export", testRunId)}`,
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
