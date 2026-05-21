import { expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { extractOtelSpans } from "../../helpers/trace-summary";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const spanTreeSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "braintrust-span-tree.json",
);

test("otel-compat-mixed-tracing unifies Braintrust and OTEL spans into one trace", async () => {
  await withScenarioHarness(
    async ({ requestsAfter, runScenarioDir, testRunEvents }) => {
      await runScenarioDir({ scenarioDir });

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

      await matchSpanTreeSnapshot(btEvents, spanTreeSnapshotPath);
    },
  );
});
