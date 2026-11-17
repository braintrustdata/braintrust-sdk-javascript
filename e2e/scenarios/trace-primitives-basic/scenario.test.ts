import { expect, test } from "vite-plus/test";
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

      await runScenarioDir({
        scenarioDir,
        runContext: {
          variantKey: "api-key",
          originalScenarioDir: resolveScenarioDir(import.meta.url),
          cassette: false,
        },
      });

      const capturedEvents = testRunEvents();
      const root = findLatestSpan(capturedEvents, "trace-primitives-root");
      const child = findLatestSpan(capturedEvents, "basic-child");
      const error = findLatestSpan(capturedEvents, "basic-error");

      expect(root).toBeDefined();
      expect(child).toBeDefined();
      expect(error).toBeDefined();

      expect(child?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(error?.span.parentIds).toEqual([root?.span.id ?? ""]);
      // With the default OTEL-compatible hex ids, root_span_id is a distinct
      // trace id shared across the whole trace, not the root span's own id.
      expect(root?.span.rootId).not.toBe(root?.span.id);
      expect(child?.span.rootId).toBe(root?.span.rootId);
      expect(error?.span.rootId).toBe(root?.span.rootId);

      await matchSpanTreeSnapshot(capturedEvents, spanTreeSnapshotPath);

      const requests = requestsAfter(
        cursor,
        (request) =>
          request.path === "/api/apikey/login" ||
          request.path === "/api/project/register" ||
          request.path === "/version" ||
          request.path === "/logs3",
      );

      expect(
        requests.filter((request) => request.path === "/api/apikey/login"),
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.path === "/api/project/register"),
      ).toHaveLength(1);

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

test.each(["ingest-key", "ingest-key-browser"])(
  "%s sends traces without login or project discovery",
  async (variantKey) => {
    await withScenarioHarness(
      async ({
        requestCursor,
        requestsAfter,
        runScenarioDir,
        runNodeScenarioDir,
        events,
      }) => {
        const cursor = requestCursor();
        const run =
          variantKey === "ingest-key-browser"
            ? runNodeScenarioDir
            : runScenarioDir;
        await run({
          nodeArgs: ["--conditions=browser", "--import", "tsx"],
          scenarioDir,
          entry: "ingest-key.ts",
          runContext: {
            variantKey,
            originalScenarioDir: resolveScenarioDir(import.meta.url),
            cassette: false,
          },
        });
        const requests = requestsAfter(cursor);
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every(
            (request) => request.method === "POST" && request.path === "/logs3",
          ),
        ).toBe(true);
        for (const request of requests) {
          expect(request.headers.authorization).toBe("Bearer bt-ik-e2e-test");
          expect(request.rawBody).not.toContain("ignored-project");
          const rows = (request.jsonBody as { rows: Record<string, unknown>[] })
            .rows;
          expect(
            rows.every(
              (row) => row.project_id === undefined && row.log_id === "g",
            ),
          ).toBe(true);
        }
        const capturedEvents = events();
        const root = findLatestSpan(capturedEvents, "ingest-key-root");
        const remote = findLatestSpan(capturedEvents, "ingest-key-remote");
        const child = findLatestSpan(capturedEvents, "ingest-key-child");
        expect(root?.output).toBe("updated remotely");
        expect(remote?.span.rootId).toBe(root?.span.rootId);
        expect(remote?.span.parentIds).toEqual([root?.span.id]);
        expect(child?.input).toMatchObject({
          attachment: "[Attachment blocked by ingest key policy]",
        });
        await matchSpanTreeSnapshot(
          capturedEvents,
          resolveFileSnapshotPath(import.meta.url, "ingest-key.span-tree.json"),
        );
      },
    );
  },
);
