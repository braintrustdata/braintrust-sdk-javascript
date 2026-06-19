import { setTimeout as delay } from "node:timers/promises";
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BraintrustSpanProcessor } from "@braintrust/otel";
import { setupMockOtlpCollector } from "../src/test-helpers.js";
import {
  displayTestResults,
  hasFailures,
  type TestResult,
} from "../../../../../../js/smoke/shared/dist/index.mjs";

async function main() {
  const results: TestResult[] = [];
  const collector = await setupMockOtlpCollector();

  const previousApiUrl = process.env.BRAINTRUST_API_URL;
  process.env.BRAINTRUST_API_URL = collector.url;

  try {
    // Use real OpenTelemetry SDK with BraintrustSpanProcessor
    const sdk = new NodeSDK({
      serviceName: "test-service",
      spanProcessor: new BraintrustSpanProcessor({
        apiKey: "smoke-test-api-key",
      }) as unknown as SpanProcessor,
    });

    await sdk.start();

    try {
      const tracer = trace.getTracer("test-tracer");
      await tracer.startActiveSpan("test-span", async (span) => {
        span.setAttributes({ "test.attr": "value" });
        span.end();
      });
    } finally {
      await sdk.shutdown();
    }

    await delay(50); // Let exports flush

    if (collector.payloads.length > 0) {
      results.push({
        status: "pass",
        name: "Basic OTEL span export",
      });
    } else {
      results.push({
        status: "fail",
        name: "Basic OTEL span export",
        error: { message: "No spans exported" },
      });
    }
  } catch (error) {
    results.push({
      status: "fail",
      name: "Basic OTEL span export",
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  } finally {
    process.env.BRAINTRUST_API_URL = previousApiUrl;
    await collector.cleanup();
  }

  displayTestResults({
    scenarioName: "OTEL v1 Basic Test Results",
    results,
  });

  if (hasFailures(results)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
