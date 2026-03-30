import { BraintrustExporter } from "@braintrust/otel";
import { registerOTel } from "@vercel/otel";
import { initLogger } from "braintrust";
import { scopedName } from "./lib/runtime-check";

export async function register() {
  void initLogger;
  (
    globalThis as { __btNextjsInstrumentationRegistered?: boolean }
  ).__btNextjsInstrumentationRegistered = true;

  registerOTel({
    serviceName: "nextjs-instrumentation-e2e",
    traceExporter: new BraintrustExporter({
      apiKey: process.env.BRAINTRUST_API_KEY!,
      apiUrl: process.env.BRAINTRUST_API_URL!,
      parent: `project_name:${scopedName("e2e-nextjs-instrumentation")}`,
      filterAISpans: false,
    }) as any,
  });
}
