import { expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "./helpers/normalize";
import { withScenarioHarness } from "./helpers/scenario-harness";
import { findLatestSpan } from "./helpers/trace-selectors";
import { summarizeEvent } from "./helpers/trace-summary";

test("trace-context-and-continuation supports reattachment and late span updates", async () => {
  await withScenarioHarness(
    async ({ payloads, runScenario, testRunEvents, testRunId }) => {
      await runScenario("scenarios/trace-context-and-continuation.ts");

      const capturedEvents = testRunEvents();
      const root = findLatestSpan(capturedEvents, "context-root");
      const currentChild = findLatestSpan(capturedEvents, "current-child");
      const reattachedChild = findLatestSpan(
        capturedEvents,
        "reattached-child",
      );
      const lateUpdate = findLatestSpan(capturedEvents, "late-update");

      expect(root).toBeDefined();
      expect(currentChild).toBeDefined();
      expect(reattachedChild).toBeDefined();
      expect(lateUpdate).toBeDefined();

      expect(currentChild?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(reattachedChild?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(reattachedChild?.span.rootId).toBe(root?.span.rootId);
      expect(lateUpdate?.row.metadata).toMatchObject({
        patched: true,
        testRunId,
      });
      expect(lateUpdate?.row.output).toEqual({
        state: "updated",
      });

      expect(
        normalizeForSnapshot(
          [
            "context-root",
            "current-child",
            "reattached-child",
            "late-update",
          ].map((name) =>
            summarizeEvent(findLatestSpan(capturedEvents, name)!),
          ) as Json,
        ),
      ).toMatchSnapshot("span-events");

      const mutationRows = payloads()
        .flatMap((payload) => payload.rows)
        .filter((row) => {
          const metadata =
            row.metadata && typeof row.metadata === "object"
              ? row.metadata
              : null;
          return (
            metadata !== null &&
            "testRunId" in metadata &&
            (metadata as Record<string, unknown>).testRunId === testRunId &&
            row.id === lateUpdate?.row.id
          );
        });

      expect(normalizeForSnapshot(mutationRows as Json)).toMatchSnapshot(
        "late-update-payloads",
      );
    },
  );
});
