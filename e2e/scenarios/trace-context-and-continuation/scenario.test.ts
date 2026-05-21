import { expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  matchFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import type { Json } from "../../helpers/normalize";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const spanTreeSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "span-tree.json",
);
const lateUpdatePayloadsSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "late-update-payloads.json",
);

test("trace-context-and-continuation supports reattachment and late span updates", async () => {
  await withScenarioHarness(
    async ({ payloads, runScenarioDir, testRunEvents, testRunId }) => {
      await runScenarioDir({ scenarioDir });

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

      await matchSpanTreeSnapshot(capturedEvents, spanTreeSnapshotPath);

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

      await matchFileSnapshot(
        formatJsonFileSnapshot(mutationRows as Json),
        lateUpdatePayloadsSnapshotPath,
      );
    },
  );
});
