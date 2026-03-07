import { expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "./helpers/normalize";
import { withScenarioHarness } from "./helpers/scenario-harness";
import { findLatestSpan } from "./helpers/trace-selectors";
import { extractOtelSpans, summarizeEvent } from "./helpers/trace-summary";

test("otel-compat-mixed-tracing unifies Braintrust and OTEL spans into one trace", async () => {
  await withScenarioHarness(
    async ({ requestsAfter, runScenario, testRunEvents }) => {
      await runScenario("scenarios/otel-compat-mixed-tracing.ts");

      const btEvents = testRunEvents();
      const btRoot = findLatestSpan(btEvents, "bt-root");
      const btChild = findLatestSpan(btEvents, "bt-child-under-otel");

      expect(btRoot).toBeDefined();
      expect(btChild).toBeDefined();

      const otelRequests = requestsAfter(
        0,
        (request) => request.path === "/otel/v1/traces",
      );
      expect(otelRequests.length).toBeGreaterThanOrEqual(1);

      const otelSpans = extractOtelSpans(otelRequests[0].jsonBody);
      const otelMiddle = otelSpans.find((span) => span.name === "otel-middle");

      expect(otelMiddle).toBeDefined();
      expect(otelMiddle?.traceId).toBe(btRoot?.span.rootId);
      expect(otelMiddle?.parentSpanId).toBe(btRoot?.span.id);
      expect(btChild?.span.rootId).toBe(btRoot?.span.rootId);
      expect(btChild?.span.parentIds).toContain(otelMiddle?.spanId ?? "");

      expect(
        normalizeForSnapshot(
          [btRoot, btChild].map((event) => summarizeEvent(event!)) as Json,
        ),
      ).toMatchSnapshot("braintrust-span-events");
    },
  );
});
