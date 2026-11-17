import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BraintrustExporter,
  BraintrustSpanProcessor,
  braintrustOtlpConfig,
} from "../src/otel";

type TestExportOptions = Parameters<typeof braintrustOtlpConfig>[0] & {
  filterAISpans?: boolean;
  customFilter?: ConstructorParameters<
    typeof BraintrustExporter
  >[0]["customFilter"];
  environment?: { type?: string; name?: string };
};

export function createTestExporter(options: TestExportOptions) {
  return new BraintrustExporter({
    ...options,
    exporter: new OTLPTraceExporter(braintrustOtlpConfig(options)),
  });
}

export function createTestProcessor(options: TestExportOptions) {
  return new BraintrustSpanProcessor({
    ...options,
    processor: new BatchSpanProcessor(
      createTestExporter({
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        parent: options.parent,
        headers: options.headers,
        environment: options.environment,
      }),
    ),
  });
}
