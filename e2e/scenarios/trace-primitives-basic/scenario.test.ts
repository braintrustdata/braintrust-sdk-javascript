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
import { summarizeRequest } from "../../helpers/trace-summary";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const spanTreeSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "span-tree.json",
);
const requestFlowSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "request-flow.json",
);

test("trace-primitives-basic collects a minimal manual trace tree", async () => {
  await withScenarioHarness(
    async ({ requestCursor, requestsAfter, runScenarioDir, testRunEvents }) => {
      const cursor = requestCursor();

      await runScenarioDir({ scenarioDir });

      const capturedEvents = testRunEvents();
      const root = findLatestSpan(capturedEvents, "trace-primitives-root");
      const child = findLatestSpan(capturedEvents, "basic-child");
      const error = findLatestSpan(capturedEvents, "basic-error");

      expect(root).toBeDefined();
      expect(child).toBeDefined();
      expect(error).toBeDefined();

      expect(child?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(error?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(root?.span.rootId).toBe(root?.span.id);

      await matchSpanTreeSnapshot(capturedEvents, spanTreeSnapshotPath);

      const requests = requestsAfter(
        cursor,
        (request) =>
          request.path === "/api/apikey/login" ||
          request.path === "/api/project/register" ||
          request.path === "/version" ||
          request.path === "/logs3",
      );

      await matchFileSnapshot(
        formatJsonFileSnapshot(
          requests.map((request) =>
            summarizeRequest(request, {
              normalizeJsonRawBody: true,
            }),
          ) as Json,
        ),
        requestFlowSnapshotPath,
      );
    },
  );
});
