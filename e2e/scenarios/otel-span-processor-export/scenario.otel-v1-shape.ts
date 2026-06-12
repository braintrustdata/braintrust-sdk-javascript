import { TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
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
    parent: `project_name:${scopedName("e2e-otel-v1-shape-export", testRunId)}`,
  });
  const parentSpanId = "3333333333333333";
  const v1Span = {
    name: "gen_ai.otel-v1-compat",
    spanContext: () => ({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: TraceFlags.SAMPLED,
    }),
    parentSpanId,
    instrumentationLibrary: { name: "otel-v1-e2e-lib", version: "1.2.3" },
    kind: 0,
    startTime: [0, 0],
    endTime: [0, 1],
    status: { code: 0 },
    attributes: {
      "gen_ai.system": "openai",
      scenario: "otel-span-processor-export",
      testRunId,
    },
    events: [],
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    resource: {
      attributes: {
        "service.name": "otel-v1-e2e-service",
      },
      asyncAttributesPending: false,
    },
  } as unknown as ReadableSpan;

  processor.onEnd(v1Span);
  await processor.forceFlush();
  await processor.shutdown();
}

runMain(main);
