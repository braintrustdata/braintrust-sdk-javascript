import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { BraintrustSpanProcessor } from "@braintrust/otel";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const processor = new BraintrustSpanProcessor({
    apiKey: process.env.BRAINTRUST_API_KEY!,
    apiUrl: process.env.BRAINTRUST_API_URL!,
    parent: `project_name:${scopedName("e2e-otel-v1-span-processor-export", testRunId)}`,
  });
  const provider = new BasicTracerProvider() as BasicTracerProvider & {
    addSpanProcessor: (processor: BraintrustSpanProcessor) => void;
  };
  provider.addSpanProcessor(processor);
  trace.setGlobalTracerProvider(provider);

  const tracer = trace.getTracer("otel-v1-e2e-lib", "1.2.3");
  const rootSpan = tracer.startSpan("otel-v1-root");
  const rootContext = trace.setSpan(context.active(), rootSpan);
  const aiSpan = tracer.startSpan(
    "gen_ai.otel-v1-compat",
    undefined,
    rootContext,
  );
  aiSpan.setAttribute("gen_ai.system", "openai");
  aiSpan.setAttribute("scenario", "otel-v1-span-processor-export");
  aiSpan.setAttribute("testRunId", testRunId);
  aiSpan.end();
  rootSpan.end();

  await processor.forceFlush();
  await provider.shutdown();
}

runMain(main);
