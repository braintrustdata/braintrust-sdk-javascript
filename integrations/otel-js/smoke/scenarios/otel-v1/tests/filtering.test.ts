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

type OtelPayload = {
  resourceSpans?: Array<{
    scopeSpans?: Array<{
      spans?: Array<{ name?: string }>;
    }>;
  }>;
};

function flattenSpans(payloads: OtelPayload[]) {
  return payloads.flatMap(
    (p) =>
      p.resourceSpans?.flatMap(
        (rs) => rs.scopeSpans?.flatMap((ss) => ss.spans ?? []) ?? [],
      ) ?? [],
  );
}

async function main() {
  const results: TestResult[] = [];
  const collector = await setupMockOtlpCollector();

  const previousApiUrl = process.env.BRAINTRUST_API_URL;
  process.env.BRAINTRUST_API_URL = collector.url;

  try {
    // Test filterAISpans option
    const sdk = new NodeSDK({
      serviceName: "filtering-test",
      spanProcessor: new BraintrustSpanProcessor({
        apiKey: "smoke-test-api-key",
        filterAISpans: true,
      }) as unknown as SpanProcessor,
    });

    await sdk.start();

    try {
      const tracer = trace.getTracer("test-tracer");

      await tracer.startActiveSpan("root.span", async (rootSpan) => {
        // This AI span should be exported
        await tracer.startActiveSpan("ai.span", async (aiSpan) => {
          aiSpan.setAttributes({ model: "gpt-4o-mini" });
          aiSpan.end();
        });

        // This non-AI span should be filtered out
        await tracer.startActiveSpan("logging.span", async (logSpan) => {
          logSpan.end();
        });

        rootSpan.end();
      });
    } finally {
      await sdk.shutdown();
    }

    await delay(50);

    const exportedSpans = flattenSpans(collector.payloads as OtelPayload[]);
    const names = exportedSpans
      .map((s) => s.name)
      .filter((n): n is string => !!n);

    // Test 1: Root span should be filtered
    if (!names.includes("root.span")) {
      results.push({
        status: "pass",
        name: "Root span filtered correctly",
      });
    } else {
      results.push({
        status: "fail",
        name: "Root span filtered correctly",
        error: { message: "Root span should be filtered but was exported" },
      });
    }

    // Test 2: AI span should be exported
    if (names.includes("ai.span")) {
      results.push({
        status: "pass",
        name: "AI span exported correctly",
      });
    } else {
      results.push({
        status: "fail",
        name: "AI span exported correctly",
        error: { message: "AI span should be exported but was filtered" },
      });
    }

    // Test 3: Non-AI span should be filtered
    if (!names.includes("logging.span")) {
      results.push({
        status: "pass",
        name: "Non-AI span filtered correctly",
      });
    } else {
      results.push({
        status: "fail",
        name: "Non-AI span filtered correctly",
        error: { message: "Logging span should be filtered but was exported" },
      });
    }
  } catch (error) {
    results.push({
      status: "fail",
      name: "AI span filtering test",
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
    scenarioName: "OTEL v1 Filtering Test Results",
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
