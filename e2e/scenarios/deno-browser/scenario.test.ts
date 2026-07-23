import { expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  matchFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
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
const TIMEOUT_MS = 90_000;
const CONFIGURED_PROJECT_NAME =
  process.env.BRAINTRUST_E2E_PROJECT_NAME || "sdk-e2e-tests";

function findEventByCase(events: CapturedLogEvent[], testCase: string) {
  return events.find((event) => {
    const metadata = event.row.metadata as Record<string, unknown> | undefined;
    return metadata?.case === testCase;
  });
}

test(
  "deno-browser captures real HTTP traces from the browser build in Deno",
  {
    timeout: TIMEOUT_MS,
  },
  async () => {
    await withScenarioHarness(
      async ({
        requestCursor,
        requestsAfter,
        runDenoScenarioDir,
        testRunEvents,
        testRunId,
      }) => {
        const cursor = requestCursor();

        await runDenoScenarioDir({
          env: { BRAINTRUST_E2E_PROJECT_NAME: CONFIGURED_PROJECT_NAME },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });

        const capturedEvents = testRunEvents();
        const basicSpan = findLatestSpan(
          capturedEvents,
          "deno browser basic span",
        );
        const jsonAttachment = findEventByCase(
          capturedEvents,
          "json-attachment",
        );
        const parentSpan = findLatestSpan(
          capturedEvents,
          "deno browser parent span",
        );
        const childSpan = findLatestSpan(
          capturedEvents,
          "deno browser child span",
        );
        const nestedParent = findLatestSpan(
          capturedEvents,
          "deno browser nested parent span",
        );
        const nestedChild = findLatestSpan(
          capturedEvents,
          "deno browser nested child span",
        );
        const nestedGrandchild = findLatestSpan(
          capturedEvents,
          "deno browser nested grandchild span",
        );
        const currentSpan = findLatestSpan(
          capturedEvents,
          "deno browser current span",
        );

        for (const span of [
          basicSpan,
          jsonAttachment,
          parentSpan,
          childSpan,
          nestedParent,
          nestedChild,
          nestedGrandchild,
          currentSpan,
        ]) {
          expect(span).toBeDefined();
        }

        expect(basicSpan?.input).toBe("What is the capital of France?");
        expect(basicSpan?.output).toBe("Paris");
        expect(basicSpan?.expected).toBe("Paris");
        expect(basicSpan?.row.metadata).toMatchObject({
          case: "basic-span",
          scenario: "deno-browser",
          testRunId,
          transport: "http",
        });

        expect(jsonAttachment?.input).toMatchObject({
          type: "chat_completion",
        });
        expect(jsonAttachment?.row.metadata).toMatchObject({
          case: "json-attachment",
          scenario: "deno-browser",
          testRunId,
        });
        expect(jsonAttachment?.output).toMatchObject({
          attachment: true,
        });

        expect(parentSpan?.output).toMatchObject({
          phase: "parent",
          ok: true,
        });
        expect(childSpan?.output).toMatchObject({
          phase: "child",
          ok: true,
        });
        expect(childSpan?.span.parentIds).toEqual([]);
        expect(nestedChild?.span.parentIds).toEqual([]);
        expect(nestedGrandchild?.span.parentIds).toEqual([]);
        expect(nestedGrandchild?.output).toBeUndefined();
        expect(currentSpan?.output).toBeUndefined();

        const requests = requestsAfter(
          cursor,
          (request) =>
            request.path === "/api/apikey/login" ||
            request.path === "/api/project/register" ||
            request.path === "/logs3",
        );

        expect(requests.map((request) => request.path)).toEqual(
          expect.arrayContaining([
            "/api/apikey/login",
            "/api/project/register",
            "/logs3",
          ]),
        );

        await matchSpanTreeSnapshot(
          capturedEvents,
          resolveFileSnapshotPath(import.meta.url, "span-tree.json"),
        );

        await matchFileSnapshot(
          formatJsonFileSnapshot(
            requests.map((request) =>
              summarizeRequest(request, {
                normalizeJsonRawBody: true,
              }),
            ) as Json,
          ),
          resolveFileSnapshotPath(import.meta.url, "request-flow.json"),
        );
      },
    );
  },
);
